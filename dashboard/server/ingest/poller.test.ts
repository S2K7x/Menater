/**
 * The pull transport, and the four ways it could lose an alert.
 *
 * ============================================================================
 * WHY THESE PARTICULAR ASSERTIONS
 *
 * A poller that works is easy to write and easy to test. What is hard, and what
 * these tests are for, is the poller that APPEARS to work while quietly
 * skipping alerts — the same failure mode the Tracking tab exists to expose,
 * rebuilt in the transport layer:
 *
 *   1. A failed or empty poll must not advance the cursor. A source that is
 *      down returns nothing, exactly like a source where nothing happened.
 *   2. The window must reach back further than the cursor, or an alert
 *      timestamped at detection and indexed a second later is lost forever.
 *   3. A response we cannot read must be an ERROR, not "zero alerts". Those
 *      are opposite facts and only one of them is good news.
 *   4. An outbound credential must come from the closed catalogue. The header
 *      name and the address are both typed into the same form.
 * ============================================================================
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultPolicy, type PullSource } from './policy.ts';
import {
  Poller, backoffFor, extractItems, newestTimestamp, pollSource, pollUrl, readCapped,
} from './poller.ts';
import { recordPoll, resetCursorCache } from './cursors.ts';

const SOURCE: PullSource = {
  source: 'generic',
  enabled: true,
  url: 'https://siem.example.com/alerts',
  cursorParam: 'since',
  authHeader: '',
  authCredential: '',
  itemsPath: '',
};

const alert = (id: string, timestamp: string) => ({
  alert_id: id,
  rule_name: 'Multiple failed SSH logins',
  severity: 'low',
  timestamp,
  raw_log: 'sshd: invalid user',
});

/** A `fetch` that answers once with this body, and records what it was asked. */
function stubFetch(body: unknown, init: { status?: number; text?: string } = {}) {
  const calls: string[] = [];
  const impl = vi.fn(async (url: string) => {
    calls.push(String(url));
    const payload = init.text ?? JSON.stringify(body);
    return new Response(payload, {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { impl: impl as unknown as typeof globalThis.fetch, calls };
}

beforeEach(() => {
  resetCursorCache();
});

describe('extractItems', () => {
  it('reads the body itself when no path is named', () => {
    expect(extractItems([{ a: 1 }], '').items).toHaveLength(1);
  });

  it('reads a nested list when one is named', () => {
    expect(extractItems({ data: { alerts: [{ a: 1 }, { b: 2 }] } }, 'data.alerts').items)
      .toHaveLength(2);
  });

  it('calls an unreadable response an ERROR, never zero alerts', () => {
    // The distinction this whole file is about: "nothing happened" and "we
    // could not find the alerts" must never print the same reassuring answer.
    expect(extractItems({ results: [] }, 'data.alerts').error).toMatch(/no list of alerts/);
    expect(extractItems({ nope: true }, '').error).toMatch(/not a list of alerts/);
  });
});

describe('newestTimestamp', () => {
  it('takes the newest of what we actually received', () => {
    expect(newestTimestamp([
      alert('a', '2026-09-04T10:00:00Z'),
      alert('b', '2026-09-04T12:00:00Z'),
      alert('c', '2026-09-04T11:00:00Z'),
    ])).toBe('2026-09-04T12:00:00Z');
  });

  it('invents nothing when nothing carries a readable date', () => {
    // `null` leaves the cursor where it was: re-reading a window costs a dedup
    // lookup, moving a cursor past undated alerts costs the alerts.
    expect(newestTimestamp([{ alert_id: 'a', timestamp: 'not a date' }])).toBeNull();
    expect(newestTimestamp([])).toBeNull();
  });
});

describe('pollUrl', () => {
  it('reaches back further than the cursor, by the overlap', () => {
    const url = pollUrl(SOURCE, '2026-09-04T12:00:00.000Z', 30, new Date('2026-09-04T12:05:00Z'));
    expect(new URL(url).searchParams.get('since')).toBe('2026-09-04T11:59:30.000Z');
  });

  it('names the parameter the source asked for, not one we chose', () => {
    const url = pollUrl({ ...SOURCE, cursorParam: 'from' }, null, 0, new Date('2026-09-04T12:00:00Z'));
    expect(new URL(url).searchParams.get('from')).toBe('2026-09-04T12:00:00.000Z');
  });

  it('LOOKS BACK when there is no cursor yet, instead of asking for "now"', () => {
    // The silent hole this fixes: an empty poll does not advance the cursor,
    // so a source that has never delivered keeps a null one. Asking `now` each
    // time meant the window BETWEEN two polls was requested by neither, and
    // every alert raised before the first delivery fell into it — permanently,
    // under a green check.
    const url = pollUrl(SOURCE, null, 30, new Date('2026-09-04T12:00:00Z'), 60);
    expect(new URL(url).searchParams.get('since')).toBe('2026-09-04T11:58:30.000Z');
  });

  it('looks back further than the gap between two polls, so windows overlap', () => {
    // The property that makes it correct rather than merely better: the
    // lookback is interval + overlap, which is by construction longer than the
    // time since the previous poll.
    const interval = 60;
    const overlap = 30;
    const first = new Date('2026-09-04T12:00:00Z');
    const second = new Date(first.getTime() + interval * 1000);
    const askedFirst = Date.parse(
      new URL(pollUrl(SOURCE, null, overlap, first, interval)).searchParams.get('since')!,
    );
    const askedSecond = Date.parse(
      new URL(pollUrl(SOURCE, null, overlap, second, interval)).searchParams.get('since')!,
    );
    // The second window starts before the first poll happened: nothing can sit
    // between them.
    expect(askedSecond).toBeLessThan(first.getTime());
    expect(askedFirst).toBeLessThan(askedSecond);
  });
});

describe('pollSource', () => {
  const policy = defaultPolicy();

  it('delivers what it read, and moves the cursor onto it', async () => {
    const { impl } = stubFetch([alert('a-1', '2026-09-04T10:00:00Z')]);
    const deliver = vi.fn(async () => 'run-1');
    const out = await pollSource(SOURCE, policy, { deliver, fetchImpl: impl });

    expect(out.error).toBeNull();
    expect(out.accepted).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(out.since).toBe('2026-09-04T10:00:00Z');
  });

  it('does NOT move the cursor on an empty poll', async () => {
    const { impl } = stubFetch([]);
    const out = await pollSource(SOURCE, policy, { deliver: vi.fn(), fetchImpl: impl });
    expect(out.accepted).toBe(0);
    // Still null: a source that is down and a source that is quiet look
    // identical from here, and only one of them is safe to skip past.
    expect(out.since).toBeNull();
  });

  it('does NOT move the cursor when the source refuses us', async () => {
    const { impl } = stubFetch(null, { status: 429, text: '' });
    const out = await pollSource(SOURCE, policy, { deliver: vi.fn(), fetchImpl: impl });
    expect(out.error).toMatch(/HTTP 429/);
    expect(out.since).toBeNull();
  });

  it('names the status rather than saying "the source failed"', async () => {
    const { impl } = stubFetch(null, { status: 401, text: '' });
    const out = await pollSource(SOURCE, policy, { deliver: vi.fn(), fetchImpl: impl });
    // 401 is a key, 429 is a quota, 503 is an outage. One word for all three
    // sends someone to regenerate a key that was always fine.
    expect(out.error).toMatch(/401/);
  });

  it('counts items with no alert id instead of skipping them silently', async () => {
    const { impl } = stubFetch([{ rule_name: 'nameless' }, alert('a-1', '2026-09-04T10:00:00Z')]);
    const out = await pollSource(SOURCE, policy, { deliver: vi.fn(), fetchImpl: impl });
    expect(out.unusable).toBe(1);
    expect(out.accepted).toBe(1);
  });

  it('refuses a source with no mapping, by name', async () => {
    const { impl } = stubFetch([]);
    const out = await pollSource({ ...SOURCE, source: 'splunk' }, policy, {
      deliver: vi.fn(), fetchImpl: impl,
    });
    expect(out.error).toMatch(/no mapping for source "splunk"/);
    expect(impl).not.toHaveBeenCalled();
  });

  it('refuses a credential outside the console’s closed catalogue', async () => {
    const { impl } = stubFetch([]);
    const out = await pollSource(
      { ...SOURCE, authHeader: 'Authorization', authCredential: 'AWS_SECRET_ACCESS_KEY' },
      policy,
      { deliver: vi.fn(), fetchImpl: impl },
    );
    // Reading an arbitrary variable into an outbound header, at an address
    // typed in the same form, is an exfiltration primitive with a save button.
    expect(out.error).toMatch(/not one of the credentials/);
    expect(impl).not.toHaveBeenCalled();
  });

  it('calls a poll that placed NOTHING a failure, however well the HTTP went', async () => {
    // The defect this test exists for: with no database every delivery throws,
    // the GET is a clean 200, and the first version reported `error: null` —
    // a green check over a pipeline dropping everything it was handed.
    const { impl } = stubFetch([alert('a-1', '2026-09-04T10:00:00Z')]);
    const deliver = vi.fn().mockRejectedValue(new Error('no engine: no database is configured.'));
    const out = await pollSource(SOURCE, policy, { deliver, fetchImpl: impl });

    expect(out.accepted).toBe(0);
    expect(out.error).toMatch(/delivered none/);
    // And it names the cause, so "no database" does not read as "the source is
    // down" and send someone to check a firewall.
    expect(out.error).toMatch(/no database is configured/);
    expect(out.since).toBeNull();
  });

  it('says a partial batch was partial, rather than reporting what got through', async () => {
    const { impl } = stubFetch([
      alert('a-1', '2026-09-04T10:00:00Z'),
      alert('a-2', '2026-09-04T11:00:00Z'),
    ]);
    const deliver = vi.fn()
      .mockResolvedValueOnce('run-1')
      .mockRejectedValueOnce(new Error('engine failed'));
    const out = await pollSource(SOURCE, policy, { deliver, fetchImpl: impl });
    expect(out.accepted).toBe(1);
    expect(out.error).toMatch(/delivered 1 of 2/);
  });

  it('stops the batch at the first delivery failure, and does not skip past it', async () => {
    const { impl } = stubFetch([
      alert('a-1', '2026-09-04T10:00:00Z'),
      alert('a-2', '2026-09-04T11:00:00Z'),
      alert('a-3', '2026-09-04T12:00:00Z'),
    ]);
    const deliver = vi.fn()
      .mockResolvedValueOnce('run-1')
      .mockRejectedValueOnce(new Error('no engine'));
    const out = await pollSource(SOURCE, policy, { deliver, fetchImpl: impl });

    expect(out.accepted).toBe(1);
    // The cursor lands on the LAST DELIVERED alert, not the last one read:
    // otherwise a-2 and a-3 are behind the cursor and nobody ever fetches them.
    expect(out.since).toBe('2026-09-04T10:00:00Z');
  });

  it('reads no more than the batch size in one poll', async () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      alert(`a-${i}`, `2026-09-04T10:0${i}:00Z`));
    const { impl } = stubFetch(many);
    const deliver = vi.fn(async () => 'run');
    const out = await pollSource(
      SOURCE, { ...policy, pull: { ...policy.pull, batchSize: 4 } },
      { deliver, fetchImpl: impl },
    );
    expect(out.accepted).toBe(4);
  });
});


/* ==========================================================================
 * The bounds — each one is a defect this file already shipped, or one the
 * codebase has paid for elsewhere and would have paid for again here.
 * ========================================================================== */

describe('the response body is capped', () => {
  it('refuses a body over the cap instead of buffering it', async () => {
    const big = new Response('x'.repeat(2000));
    // And the limit is readable: `max / 1024 / 1024` printed "over
    // 0.00048828125 MB" here, which is a limit nobody can act on.
    await expect(readCapped(big, 500)).rejects.toThrow(/over 500 bytes/);
  });

  it('refuses early on an announced size, without reading anything', async () => {
    const res = new Response('{}', { headers: { 'content-length': String(50 * 1024 * 1024) } });
    await expect(readCapped(res, 1024)).rejects.toThrow(/announced 50 MB, over the 1 kB/);
  });

  it('reads a normal body unchanged', async () => {
    expect(await readCapped(new Response('{"a":1}'), 1024)).toBe('{"a":1}');
  });

  it('reports an oversized response as a poll failure, not a crash', async () => {
    const impl = (async () => new Response('y'.repeat(50_000_000))) as unknown as typeof globalThis.fetch;
    const out = await pollSource(SOURCE, defaultPolicy(), { deliver: vi.fn(), fetchImpl: impl });
    expect(out.error).toMatch(/MB/);
    // And it does not move the cursor: an answer we refused to read is not an
    // answer about what happened.
    expect(out.since).toBeNull();
  });
});

describe('delivery runs in bounded waves, and the cursor takes only a prefix', () => {
  it('delivers a batch concurrently rather than one at a time', async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      alert(`a-${i}`, `2026-09-04T10:0${i}:00Z`));
    const { impl } = stubFetch(many);
    let live = 0;
    let peak = 0;
    const deliver = vi.fn(async () => {
      live += 1; peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
    });
    const out = await pollSource(SOURCE, defaultPolicy(), { deliver, fetchImpl: impl });

    expect(out.accepted).toBe(8);
    // More than one at a time — a strictly sequential batch of a hundred is a
    // poll that holds a source for twenty-six minutes.
    expect(peak).toBeGreaterThan(1);
    // And bounded: never the whole batch at once.
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('stops the cursor at the FIRST failure in reading order, not the last success', async () => {
    // The defect concurrency introduces: alert 4 can succeed while alert 2
    // fails. Taking "the newest that worked" places the cursor past alert 2,
    // which nobody would ever fetch again and nothing would report.
    const batch = Array.from({ length: 4 }, (_, i) =>
      alert(`a-${i}`, `2026-09-04T1${i}:00:00Z`));
    const { impl } = stubFetch(batch);
    const deliver = vi.fn(async (_src: string, a: Record<string, unknown>) => {
      if (a.alert_id === 'a-1') throw new Error('engine failed');
    });
    const out = await pollSource(SOURCE, defaultPolicy(), { deliver, fetchImpl: impl });

    expect(out.accepted).toBe(1);
    // a-0's timestamp, never a-2's or a-3's, even though both were delivered.
    expect(out.since).toBe('2026-09-04T10:00:00Z');
    expect(out.error).toMatch(/delivered 1 of 4/);
  });
});

describe('backoffFor', () => {
  const interval = 60_000;

  it('is nothing at all while the source is answering', () => {
    expect(backoffFor(0, interval)).toBe(0);
  });

  it('never undercuts the cadence the operator chose', () => {
    for (let f = 1; f <= 10; f += 1) {
      expect(backoffFor(f, interval), `${f} failures`).toBeGreaterThanOrEqual(interval);
    }
  });

  it('grows with consecutive failures and stops at the cap', () => {
    // Jittered, so the claim is about the CEILING, not an exact value: a test
    // that asserted a precise delay would be asserting that the jitter is not
    // there.
    const samples = Array.from({ length: 200 }, () => backoffFor(20, interval));
    expect(Math.max(...samples)).toBeLessThanOrEqual(30 * 60 * 1000);
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(interval);
  });

  it('is jittered, so several sources that failed together do not return together', () => {
    const samples = new Set(Array.from({ length: 50 }, () => backoffFor(3, interval)));
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe('the poller does not hammer, and does not skip in silence', () => {
  const policyWith = (sources: PullSource[]) => ({
    ...defaultPolicy(),
    pull: { ...defaultPolicy().pull, enabled: true, sources },
  });

  it('SKIPS a source inside its backoff window, and says when it will try again', async () => {
    recordPoll('generic', { error: 'boom', received: 0, backoffMs: 10 * 60 * 1000 });
    const deliver = vi.fn();
    const impl = vi.fn() as unknown as typeof globalThis.fetch;
    const poller = new Poller(() => policyWith([SOURCE]), { deliver, fetchImpl: impl });

    const outcomes = await poller.tick();
    expect(impl).not.toHaveBeenCalled();
    // Present in the results, carrying its error and its next attempt. A
    // source silently missing reads as a poller that stopped working.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].error).toBe('boom');
    expect(outcomes[0].nextAttemptAt).toBeTruthy();
  });

  it('ignores the backoff when a person presses "poll now"', async () => {
    recordPoll('generic', { error: 'boom', received: 0, backoffMs: 10 * 60 * 1000 });
    const { impl } = stubFetch([]);
    const poller = new Poller(() => policyWith([SOURCE]), { deliver: vi.fn(), fetchImpl: impl });

    await poller.tick({ force: true });
    // A diagnostic control that answers "not yet, wait 8 minutes" is one
    // nobody presses twice.
    expect(impl).toHaveBeenCalled();
  });

  it('does NOT poll again when sync is called with the cadence unchanged', () => {
    // The defect: `sync()` ran on every settings save, and this screen saved on
    // every keystroke. Typing `120` into the interval field made three real
    // requests to somebody's SIEM.
    const { impl } = stubFetch([]);
    const policy = policyWith([SOURCE]);
    const poller = new Poller(() => policy, { deliver: vi.fn(), fetchImpl: impl });

    poller.sync();
    const afterColdStart = (impl as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(afterColdStart).toBe(1);

    poller.sync();
    poller.sync();
    poller.sync();
    expect((impl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(afterColdStart);
    poller.stop();
  });

  it('does poll on a cold start, which is what "enable polling" means', () => {
    const { impl } = stubFetch([]);
    const poller = new Poller(() => policyWith([SOURCE]), { deliver: vi.fn(), fetchImpl: impl });
    poller.sync();
    expect(impl).toHaveBeenCalledTimes(1);
    poller.stop();
  });
});
