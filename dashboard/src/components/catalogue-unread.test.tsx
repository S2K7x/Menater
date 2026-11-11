/**
 * @vitest-environment jsdom
 */
/**
 * A catalogue this console could not READ, rendered as a catalogue the server
 * does not have.
 *
 * ============================================================================
 * WHAT THIS FILE IS FOR
 *
 * Five screens fetch a list from the server when they mount — the rule
 * templates, the credential store, the assistant's providers, the threat-intel
 * sources, the MCP endpoint's state — and every one of those reads was written
 * `.catch(() => setX([]))` or `.catch(() => setX(null))`. An EMPTY catalogue
 * and a read that did not answer are two different facts, and the render could
 * not tell them apart, so each screen went on to make a CLAIM out of the
 * emptiness. Measured on the built components before the fix, with the read
 * refused and everything else answering:
 *
 *   `McpPanel`      the status pill read **Closed** and step 2 read *« No token
 *                   yet. The endpoint stays closed until there is one. »* beside
 *                   a *Generate a token* button — on an install whose endpoint
 *                   may be live with a token in use. That press is
 *                   IRREVERSIBLE: the new token replaces the old and every
 *                   client configured with it stops working.
 *
 *   `SettingsPage`  `checklistOf` reads `credentials.some(k => k.required &&
 *                   k.set)`, so a refused store read put *« 1 thing left to set
 *                   — Triage model key »* at the top of Settings on an install
 *                   where the key IS set. A false red on the one screen that
 *                   says what is left to configure — and *« a false red costs
 *                   more than no red at all »*. The Credentials section
 *                   rendered its title and no row; the assistant's provider
 *                   `<select>` rendered with no option at all.
 *
 *   `IntelPanel`    the source fold read **0 of 0 reachable** and OPENED
 *                   itself, because zero coverage is the one thing this tab
 *                   refuses to file behind a silent click. Same shape as a
 *                   verdict of `clean` over a source nobody queried, which that
 *                   tab also refuses, in its own words.
 *
 *   `RulesPage`     the template block rendered its title, its lede, and no
 *                   control and no reason.
 *
 * ============================================================================
 * WHY THIS IS ONE SUBJECT AND NOT FIVE
 *
 * The Health tab had the identical defect and it is already fixed and already
 * written down: `.catch(() => setScenarios([]))` made a read that did not
 * answer indistinguishable from a server offering no scenario, and since that
 * list was the only way to press anything there, the block rendered a title and
 * nothing. That fix was applied at ONE call site. *The mirror of a rule is not
 * the rule* — so the last claim in this file is a SUBTRACTION over the screens,
 * not a list of the five that exist tonight.
 *
 * ============================================================================
 * WHAT THE SWEEP CAN AND CANNOT SEE
 *
 * It reads source text, so it sees a SHAPE, not a behaviour: a catch that does
 * not even receive its error cannot report one, and a catch handing a setter an
 * empty literal is the exact line this night removed five times. It would not
 * notice `.catch((e) => setTemplates(fallback))`. The per-screen claims above
 * are the real guarantee; the sweep is what makes the sixth screen fail on the
 * day it is written rather than on the day somebody happens to look.
 *
 * Comments are stripped before it runs, and that is load-bearing here rather
 * than hygiene: four of these components now QUOTE the removed line in the
 * comment explaining why it went, so a sweep over raw text would be satisfied
 * by the prose describing the defect.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { render } from '../vulnpipe/test-utils.tsx';
import { api, ApiError } from '../lib/api.ts';
import { RulesPage } from './RulesPage.tsx';
import { IntelPanel } from './IntelPanel.tsx';
import { McpPanel } from './McpPanel.tsx';
import { SettingsPage } from './SettingsPage.tsx';
import type { SettingsPayload } from '../lib/types.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * What a refused read looks like from `lib/api.ts`.
 *
 * A real 503 from this server, in this server's own words: `ruleDb` wraps every
 * rule-store failure through `describePgError`, and `call()` reads the named
 * reason. The sentence matters to the assertions — a refusal that carries a
 * reason must pass it on.
 */
const REFUSED = 'Database (rules): connect ECONNREFUSED 127.0.0.1:5432';
const refuse = () => new ApiError(REFUSED);

/** Everything on screen, with runs of whitespace collapsed. */
const page = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');

/* ==========================================================================
 * 1. The rule templates
 * ========================================================================== */

async function openTemplates(templates: 'refused' | 'answered') {
  vi.spyOn(api, 'rules').mockResolvedValue({ rules: [] } as never);
  const read = vi.spyOn(api, 'ruleTemplates');
  if (templates === 'refused') read.mockRejectedValue(refuse());
  else {
    read.mockResolvedValue({
      templates: [
        {
          id: 'backup-agent',
          title: 'Nightly backup agent',
          description: 'The backup window, on the backup host.',
          action: 'suppress',
          conditions: [],
          placeholders: [],
        },
      ],
    } as never);
  }
  const user = userEvent.setup();
  render(<RulesPage />);
  await waitFor(() => expect(screen.getByRole('button', { name: /template/i })).toBeTruthy());
  await user.click(screen.getByRole('button', { name: /template/i }));
  await act(async () => {});
}

describe('the rule templates could not be read', () => {
  it('says so where the controls would be, and carries the reason', async () => {
    await openTemplates('refused');
    const note = document.querySelector('.soc-rule-templates .soc-warn-note');
    expect(note).toBeTruthy();
    expect(note!.textContent).toMatch(/could not be read/);
    expect(note!.textContent).toContain(REFUSED);
  });

  /**
   * THE BOUNDARY, and it passes before and after on purpose: a catalogue that
   * ANSWERS must still list what it holds. Saying "could not be read" over a
   * server that answered would be this defect wearing its own fix.
   */
  it('still lists the templates when the read answers', async () => {
    await openTemplates('answered');
    expect(screen.getByText('Nightly backup agent')).toBeTruthy();
    expect(document.querySelector('.soc-rule-templates .soc-warn-note')).toBeNull();
  });
});

/* ==========================================================================
 * 2. The threat-intel source catalogue
 * ========================================================================== */

const SOURCE = {
  id: 'internetdb',
  label: 'Shodan InternetDB',
  purpose: 'Open ports, with no key.',
  env: null,
  configured: true,
  kinds: ['ipv4'],
  ttl_hours: 6,
  signup: 'https://internetdb.shodan.io/',
};

async function mountLookup(providers: 'refused' | 'answered') {
  const read = vi.spyOn(api, 'intelProviders');
  if (providers === 'refused') read.mockRejectedValue(refuse());
  else read.mockResolvedValue({ providers: [SOURCE] } as never);
  render(<IntelPanel />);
  await act(async () => {});
}

/** The fold whose summary names the source catalogue. */
const sourceFold = (): HTMLDetailsElement => {
  const found = Array.from(document.querySelectorAll('details')).find(
    (d) => (d.querySelector('summary')?.textContent ?? '').includes('Sources'),
  );
  expect(found).toBeTruthy();
  return found as HTMLDetailsElement;
};

describe('the source catalogue could not be read', () => {
  it('makes no coverage claim at all', async () => {
    await mountLookup('refused');
    // `0 of 0 reachable` was the measured answer. The claim is about the SHAPE
    // of the sentence, not about one wrong pair of numbers: any figure here is
    // a count of a catalogue nobody read.
    expect(page()).not.toMatch(/\d+ of \d+ reachable/);
  });

  it('says so, and not from inside a closed fold', async () => {
    await mountLookup('refused');
    const fold = sourceFold();
    // A failure never folds, and a region inside a CLOSED `<details>` is absent
    // from the accessibility tree — so being present is not enough.
    expect(fold.open).toBe(true);
    const note = fold.querySelector('.soc-warn-note');
    expect(note).toBeTruthy();
    expect(note!.textContent).toMatch(/could not be read/);
    expect(note!.textContent).toContain(REFUSED);
  });

  /** THE BOUNDARY: the figure is the most useful sentence on this screen when
   *  the catalogue DID answer, and it is still there. */
  it('still counts what would answer when the read answers', async () => {
    await mountLookup('answered');
    expect(page()).toMatch(/1 of 1 reachable/);
    expect(sourceFold().querySelector('.soc-warn-note')).toBeNull();
  });
});

/* ==========================================================================
 * 3. The credential store, and 4. the assistant's providers
 * ========================================================================== */

/**
 * An install that is FULLY configured: a shared secret, an open endpoint, a
 * source that has delivered. The only thing the checklist cannot see by itself
 * is the model key — which is the point, because that is the item a refused
 * credential read used to invent.
 */
const SETTLED = (): SettingsPayload => ({
  settings: {
    webhook: { mode: 'hybrid', secretSet: true },
    tunnel: { hostname: '', tokenSet: false },
    console: { refreshSeconds: 20, executionWindow: 120, forceDemo: false },
    auth: { enabled: false, passwordSet: false },
    database: {
      preset: 'local', host: 'postgres', port: 5432,
      database: 'menater', user: 'menater', ssl: false, passwordSet: true,
    },
    pipeline: {
      shadowMode: true,
      slackApproval: '', slackEscalation: '', slackWarnings: '', slackCritical: '',
      ticketEndpoint: '', isolationEndpoint: '', isolationTtlMinutes: 60,
      errorWindowMinutes: 60, errorSystemicThreshold: 5, errorSuppressMinutes: 30,
    },
    variables: {},
    ingestion: { sources: [], policy: { delivery: 'hybrid', fastLane: ['critical', 'high'] } },
    assistant: {
      enabled: true, provider: 'openrouter', model: '', maxSteps: 6,
      mcpEnabled: false, mcpTokenSet: false,
    },
    inventory: { entries: [] },
    meta: { config_path: '/tmp/config.json', config_exists: true, from_env: { database: {} } },
  },
  connection_string: 'postgresql://menater:********@postgres:5432/menater',
} as unknown as SettingsPayload);

/** The model key IS set on this install. That is what makes the false red false. */
const MODEL_KEY = {
  env: 'OPENROUTER_APIKEY',
  label: 'Triage model',
  required: true,
  set: true,
  locked: false,
  source: 'store',
};

const PROVIDER = {
  id: 'openrouter',
  label: 'OpenRouter',
  key_env: 'ASSISTANT_APIKEY',
  key_url: 'https://openrouter.ai/keys',
  default_model: 'anthropic/claude-sonnet-4.5',
  model_hint: '',
};

async function mountSettings(opts: {
  credentials: 'refused' | 'answered';
  providers: 'refused' | 'answered';
}) {
  vi.spyOn(api, 'settings').mockResolvedValue(SETTLED());
  const creds = vi.spyOn(api, 'credentials');
  if (opts.credentials === 'refused') creds.mockRejectedValue(refuse());
  else creds.mockResolvedValue({ credentials: [MODEL_KEY] } as never);
  const provs = vi.spyOn(api, 'assistantProviders');
  if (opts.providers === 'refused') provs.mockRejectedValue(refuse());
  else provs.mockResolvedValue({ providers: [PROVIDER] } as never);

  const user = userEvent.setup();
  render(<SettingsPage onChanged={() => {}} alertsSeen />);
  await waitFor(() => expect(screen.getByRole('tab', { name: /Credentials/ })).toBeTruthy());
  await act(async () => {});
  return { user };
}

const openSection = async (user: ReturnType<typeof userEvent.setup>, name: RegExp) => {
  await user.click(screen.getByRole('tab', { name }));
  await act(async () => {});
};

describe('the credential store could not be read', () => {
  /**
   * The sharpest half. The checklist is the first thing on Settings, and its
   * `model` row was computed from an empty list — so a console whose key is set
   * was told *« Without it, EVERY alert takes the fail-safe verdict »*.
   *
   * The fix is not a better sentence: the list stays `null`, which the checklist
   * is ALREADY guarded on, so it makes no claim at all. Grey is the tone of the
   * undetermined, and absent is the tone of the unknown.
   */
  it('puts no setup claim at the top of Settings', async () => {
    await mountSettings({ credentials: 'refused', providers: 'answered' });
    expect(document.querySelector('.soc-setup')).toBeNull();
    expect(page()).not.toMatch(/Triage model key/);
    expect(page()).not.toMatch(/left to set/);
  });

  it('says so in the section whose rows are missing, with the reason', async () => {
    const { user } = await mountSettings({ credentials: 'refused', providers: 'answered' });
    await openSection(user, /Credentials/);
    const note = document.querySelector('.soc-warn-note');
    expect(note).toBeTruthy();
    expect(note!.textContent).toMatch(/could not be read/);
    expect(note!.textContent).toContain(REFUSED);
  });

  /**
   * THE BOUNDARY: a store that ANSWERS still drives the checklist. Removing the
   * claim altogether would be a different defect wearing this fix — the screen
   * exists to say what is left to configure.
   */
  it('still reports a fully configured install as ready when the read answers', async () => {
    await mountSettings({ credentials: 'answered', providers: 'answered' });
    expect(document.querySelector('.soc-setup')).toBeTruthy();
    expect(page()).not.toMatch(/left to set/);
  });
});

describe('the assistant provider catalogue could not be read', () => {
  it('offers no picker with nothing in it, and says why', async () => {
    const { user } = await mountSettings({ credentials: 'answered', providers: 'refused' });
    await openSection(user, /In-console assistant/);
    expect(document.querySelectorAll('select').length).toBe(0);
    const notes = Array.from(document.querySelectorAll('.soc-warn-note'))
      .map((n) => n.textContent ?? '');
    expect(notes.some((n) => /could not be read/.test(n) && n.includes(REFUSED))).toBe(true);
  });

  /** THE BOUNDARY: a catalogue that answers is still a picker with the
   *  provider in it. */
  it('still offers the provider when the read answers', async () => {
    const { user } = await mountSettings({ credentials: 'answered', providers: 'answered' });
    await openSection(user, /In-console assistant/);
    const select = document.querySelector('select');
    expect(select).toBeTruthy();
    expect(select!.textContent).toContain('OpenRouter');
  });
});

/* ==========================================================================
 * 5. The MCP endpoint's state — the one with an irreversible button under it
 * ========================================================================== */

const MCP_STATE = {
  live: true,
  path: '/api/mcp',
  token_set: true,
  tools: ['list_alerts'],
  prompts: [{ id: 'explain-alert', title: 'Explain an alert' }],
  resources: ['menater://queue'],
};

async function mountMcp(state: 'refused' | 'answered') {
  const read = vi.spyOn(api, 'mcpState');
  if (state === 'refused') read.mockRejectedValue(refuse());
  else read.mockResolvedValue(MCP_STATE as never);
  render(<McpPanel settings={{ mcpEnabled: true }} onToggle={() => {}} busy={false} />);
  await act(async () => {});
}

const generateButton = () =>
  Array.from(document.querySelectorAll('button')).find(
    (b) => /Generate a (new )?token/.test(b.textContent ?? ''),
  ) as HTMLButtonElement | undefined;

describe('the MCP endpoint state could not be read', () => {
  it('does not report the endpoint as closed', async () => {
    await mountMcp('refused');
    const pill = document.querySelector('.soc-pill');
    expect(pill).toBeTruthy();
    expect(pill!.textContent).toBe('Unknown');
    // Grey, not the orange of "closed": that tone is a fact nobody established.
    expect(pill!.className).toContain('soc-pill-neutral');
  });

  it('does not claim there is no token, and says why', async () => {
    await mountMcp('refused');
    expect(page()).not.toMatch(/No token yet/);
    const note = document.querySelector('.soc-warn-note');
    expect(note).toBeTruthy();
    expect(note!.textContent).toMatch(/could not be read/);
    expect(note!.textContent).toContain(REFUSED);
  });

  /**
   * The irreversible half, and the reason this screen is the worst of the five.
   * Generating a token REPLACES the one in use, and every client configured
   * with the old one stops working. A page that cannot say whether a token
   * exists cannot say what that press would destroy, so it refuses rather than
   * offers — the rule `CredentialStatus.locked` already states on the Settings
   * screen: *offering an input the server will refuse is worse than offering
   * none*, here pointed at an action nobody can undo.
   */
  it('refuses to generate a token over a state nobody established', async () => {
    await mountMcp('refused');
    expect(generateButton()?.disabled).toBe(true);
  });

  /**
   * THE BOUNDARY, and it is what separates this from breaking the feature: on
   * a state that ANSWERED, the pill, the sentence and the button are exactly
   * what they were.
   */
  it('reports and offers everything when the read answers', async () => {
    await mountMcp('answered');
    expect(document.querySelector('.soc-pill')!.textContent).toBe('Live');
    expect(page()).toMatch(/A token is set/);
    expect(generateButton()?.disabled).toBe(false);
    // Not "no warn note at all": step 3 legitimately carries one when a token
    // is set and has not just been shown. The claim is that nothing on screen
    // says the state could not be read.
    expect(page()).not.toMatch(/could not be read/);
  });
});

/* ==========================================================================
 * 6. The subtraction
 * ========================================================================== */

const COMPONENTS = import.meta.dirname;
const APP = join(COMPONENTS, '..', 'App.tsx');

/** Comments go first: four of these files quote the line this sweep hunts. */
const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1 ');

/**
 * A catch that does not RECEIVE its error cannot report one. That is the shape
 * every one of tonight's five had, and it is the cheapest thing to grep for.
 */
const BLIND_CATCH = /\.catch\(\s*\(\s*\)\s*=>/g;

/**
 * And a catch that hands a setter an empty literal, whether or not it took the
 * error. This is the removed line itself: `setTemplates([])`,
 * `setProviders([])`, `setState(null)`.
 *
 * The argument list is matched explicitly, and that is not style. The obvious
 * spelling — `\.catch\([^)]*=>` — cannot cross the `)` of `()`, so it matched
 * NONE of the five lines it was written for: a ruler that reads zero
 * everywhere. Measured against all five before this one was trusted, and the
 * five are quoted below so the claim cannot go quiet again.
 */
const EMPTY_LITERAL =
  /\.catch\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*set[A-Za-z]*\(\s*(?:\[\s*\]|null|\{\s*\})\s*\)/g;

/**
 * The five lines this night removed, verbatim from `git show HEAD`. They are
 * DATA here, not code: what they are for is proving the sweep above can still
 * see the shape it was built for.
 */
const REMOVED = [
  'api.ruleTemplates().then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));',
  'api.credentials().then((r) => setCredentials(r.credentials)).catch(() => setCredentials([]));',
  'api.assistantProviders().then((r) => setProviders(r.providers)).catch(() => setProviders([]));',
  'api.intelProviders().then((r) => setProviders(r.providers)).catch(() => setProviders([]));',
  'api.mcpState().then(setState).catch(() => setState(null));',
];

/**
 * The two places a blind catch is the right answer, each with the reason
 * visible rather than absent — and both asserted in the OTHER direction below,
 * so an exemption whose line has gone fails and asks to be deleted instead of
 * passing over nothing.
 */
const KEPT: Array<{ file: string; why: string }> = [
  {
    file: 'Assistant.tsx',
    why:
      'The assistant’s readiness. The only thing derived from it is '
      + '`blocked = state !== null && !state.ready`, so an unread state makes the '
      + 'panel PERMISSIVE and claims nothing: the question goes to the server, '
      + 'which answers or refuses in its own words.',
  },
  {
    file: 'App.tsx',
    why:
      'Signing out. Not a read of a catalogue: the local session is dropped '
      + 'either way, and a server that could not be told is a server whose '
      + 'session expires on its own.',
  },
];

const screens = (): Array<[string, string]> => {
  const files: Array<[string, string]> = [['App.tsx', readFileSync(APP, 'utf8')]];
  for (const e of readdirSync(COMPONENTS, { withFileTypes: true })) {
    if (!e.isFile() || !/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) continue;
    files.push([e.name, readFileSync(join(COMPONENTS, e.name), 'utf8')]);
  }
  return files;
};

/**
 * Both claims are NEGATIVE, so what they looked at has to travel with the
 * answer. A mutation that exempts every file left the first one green — an
 * empty sweep agrees with everything, which is the vacuous pass this project
 * has already paid for on a scan report that took green when coverage was
 * unknown. `examined` is what makes it falsifiable.
 */
function sweep(rx: RegExp, skip: Set<string>): { examined: number; offenders: string[] } {
  const offenders: string[] = [];
  let examined = 0;
  for (const [name, src] of screens()) {
    if (skip.has(name)) continue;
    examined += 1;
    const hits = withoutComments(src).match(rx) ?? [];
    if (hits.length > 0) offenders.push(`${name} (${hits.length})`);
  }
  return { examined, offenders };
}

/**
 * Enough screens that the directory was really read. The per-sweep assertion
 * below is the exact one — every screen minus the ones skipped — because a
 * FLOOR is also satisfied by an `examined` somebody hardcoded; this floor only
 * has to prove `screens()` is not an empty directory listing.
 */
const FLOOR = 20;

describe('no screen maps a failed read to an answer', () => {
  it('has no catch that throws its own error away, outside the two kept', () => {
    const all = screens().length;
    expect(all).toBeGreaterThanOrEqual(FLOOR);
    const { examined, offenders } = sweep(BLIND_CATCH, new Set(KEPT.map((k) => k.file)));
    expect(offenders).toEqual([]);
    expect(examined).toBe(all - KEPT.length);
  });

  it('hands no setter an empty catalogue from a catch, anywhere', () => {
    const all = screens().length;
    expect(all).toBeGreaterThanOrEqual(FLOOR);
    const { examined, offenders } = sweep(EMPTY_LITERAL, new Set());
    expect(offenders).toEqual([]);
    expect(examined).toBe(all);
  });

  /**
   * The other direction, and the only thing that stops the claim above being
   * vacuous: a ruler that matches nothing agrees with everything. Each kept
   * file must still contain the shape it is exempted for.
   */
  it('finds the shape it hunts in both kept files', () => {
    const read = new Map(screens());
    for (const k of KEPT) {
      const src = read.get(k.file);
      expect(src, `${k.file} is no longer a screen in this sweep`).toBeTruthy();
      expect(
        (withoutComments(src!).match(BLIND_CATCH) ?? []).length,
        `${k.file} no longer has the line it is exempted for: delete the exemption`,
      ).toBeGreaterThan(0);
      expect(k.why.length).toBeGreaterThan(40);
    }
  });

  /**
   * The other direction for the second rule, and the reason it exists: the
   * first spelling of that regex matched none of the lines it was written for.
   */
  it('still recognises every line it was built to refuse', () => {
    for (const line of REMOVED) {
      expect(line.match(EMPTY_LITERAL), line).not.toBeNull();
    }
    // And it does not fire on the guarded form, which is a different fact and
    // is covered — and exempted — by the rule above.
    expect('.catch(() => alive && setState(null));'.match(EMPTY_LITERAL)).toBeNull();
  });

});
