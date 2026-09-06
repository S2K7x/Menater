/**
 * Lookup — asking every source about one value, by hand.
 *
 * ============================================================================
 * WHAT THIS SCREEN IS FOR
 *
 * The pipeline enriches automatically, but only what an alert happened to
 * carry. Everything else — a value from a mail, a ticket, a colleague's
 * message, the second address in a log the parser did not map — has, until
 * now, meant leaving the console and opening four browser tabs. This is those
 * four tabs, in one pass, with the answers in the vocabulary the rest of the
 * console already uses.
 *
 * ============================================================================
 * THREE DECISIONS ON THIS SIDE
 *
 *  1. THE VERDICT IS NEVER THE ONLY THING SHOWN. A headline that says "clean"
 *     over a hidden list of skipped sources is the failure this console exists
 *     to expose, moved to a new screen. The count of sources that ANSWERED
 *     sits next to the verdict, always, and every card says which of the three
 *     states it is in.
 *
 *  2. THE PASSWORD NEVER LEAVES THE BROWSER. `crypto.subtle` hashes it here,
 *     five characters of the hash go to the server's relay, the comparison
 *     happens on this page. The panel says so ABOVE the field, not in a
 *     footnote — someone is about to type a real password into a web page, and
 *     they deserve to read why that is safe before they do it, not after.
 *
 *  3. THE HISTORY IS THIS TAB'S MEMORY AND NOTHING ELSE. No localStorage: a
 *     list of the addresses an analyst investigated is exactly the sort of
 *     thing that should not outlive the window it was typed in.
 * ============================================================================
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, ApiError } from '../lib/api.ts';
import { useI18n } from '../i18n/context.tsx';
import type {
  IntelProvider, IntelResult, IntelSource, ObservableKind,
} from '../lib/types.ts';
import { Explain, Fold } from './Guidance.tsx';
import { Icon } from './Icon.tsx';

/* ==========================================================================
 * THE FORM
 * ========================================================================== */

const VERDICT_TONE: Record<IntelResult['verdict'], { pill: string; icon: 'alert' | 'clock' | 'check' | 'search' }> = {
  flagged: { pill: 'soc-pill-high', icon: 'alert' },
  watch: { pill: 'soc-pill-warn', icon: 'clock' },
  clean: { pill: 'soc-pill-ok', icon: 'check' },
  unknown: { pill: 'soc-pill-info', icon: 'search' },
};

/**
 * Field names that are plumbing, not findings.
 *
 * `breaches` and `pastes` get their own list; `scanned` / `known` / `note` are
 * how a provider tells the synthesis "no record here", and the sentence they
 * produce is already in the signals. Repeated as raw rows they make the grid
 * read like debug output. Module-level, so it is not rebuilt per card.
 */
const INTERNAL_FIELDS = new Set(['breaches', 'pastes', 'scanned', 'known', 'note']);

const STATUS_TONE: Record<IntelSource['status'], string> = {
  ok: 'soc-pill-ok',
  skipped: 'soc-pill-info',
  unavailable: 'soc-pill-warn',
};

/**
 * Renders one normalised field.
 *
 * `null` is printed as an em dash rather than hidden. A field that came back
 * empty and a field the provider does not have are different facts, and the
 * only way to tell them apart on screen is to show both.
 */
function FieldValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="soc-faint">—</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="soc-faint">—</span>;
    return (
      <span className="soc-intel-chips">
        {value.slice(0, 40).map((v, i) => (
          <span className="soc-intel-chip" key={`${String(v)}-${i}`}>{String(v)}</span>
        ))}
        {value.length > 40 ? <span className="soc-faint">+{value.length - 40}</span> : null}
      </span>
    );
  }
  if (typeof value === 'boolean') return <span>{value ? 'yes' : 'no'}</span>;
  if (typeof value === 'object') return <code className="soc-intel-json">{JSON.stringify(value)}</code>;
  return <span>{String(value)}</span>;
}

/** A breach or paste list is a table, not a chip cloud. */
function BreachList({ rows }: { rows: any[] }) {
  return (
    <ul className="soc-intel-breaches">
      {rows.map((b, i) => (
        <li key={`${b.name ?? b.source}-${i}`}>
          <b>{String(b.name ?? b.source ?? '?')}</b>
          {b.breach_date || b.date ? <span className="soc-faint"> · {String(b.breach_date ?? b.date).slice(0, 10)}</span> : null}
          {b.pwn_count ? <span className="soc-faint"> · {Number(b.pwn_count).toLocaleString('en')} accounts</span> : null}
          {Array.isArray(b.data_classes) && b.data_classes.length > 0 ? (
            <span className="soc-intel-chips">
              {b.data_classes.slice(0, 8).map((dc: string) => (
                <span
                  key={dc}
                  className={/password/i.test(dc) ? 'soc-intel-chip soc-intel-chip-bad' : 'soc-intel-chip'}
                >
                  {dc}
                </span>
              ))}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SourceCard({ source }: { source: IntelSource }) {
  const { c } = useI18n();
  const t = c.intel;
  const fields = source.fields ?? {};
  // Pulled out of the generic field grid: a list of breaches reads as a list,
  // and forty data classes in a definition row read as nothing at all.
  const breaches = Array.isArray(fields.breaches) ? (fields.breaches as any[]) : null;
  const pastes = Array.isArray(fields.pastes) ? (fields.pastes as any[]) : null;
  const rest = Object.entries(fields).filter(([k]) => !INTERNAL_FIELDS.has(k));

  return (
    <section className="soc-panel soc-intel-source">
      <div className="soc-panel-head">
        <div>
          <span className="soc-kicker">{source.label}</span>
          <p className="soc-intel-source-meta">
            <span className={`soc-pill ${STATUS_TONE[source.status]}`}>{t.statuses[source.status]}</span>
            {source.cached ? <span className="soc-pill soc-pill-info">{t.cached}</span> : null}
            {source.ms !== null ? <span className="soc-faint">{t.took(source.ms)}</span> : null}
            {source.http_status !== null ? <span className="soc-faint">HTTP {source.http_status}</span> : null}
          </p>
        </div>
        {source.permalink ? (
          <a className="soc-secondary soc-icon-button" href={source.permalink} target="_blank" rel="noreferrer noopener">
            <Icon name="external" size={14} /> {t.open}
          </a>
        ) : null}
      </div>

      {source.reason ? <p className="soc-muted soc-intel-reason">{source.reason}</p> : null}

      {source.signals.length > 0 ? (
        <ul className="soc-intel-signals">
          {source.signals.map((s, i) => (
            <li key={i} className={`soc-intel-signal soc-intel-signal-${s.weight}`}>
              <Icon name={s.weight === 'strong' ? 'alert' : s.weight === 'weak' ? 'clock' : 'check'} size={14} />
              <span>{s.text}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {breaches && breaches.length > 0 ? <BreachList rows={breaches} /> : null}
      {pastes && pastes.length > 0 ? <BreachList rows={pastes} /> : null}

      {rest.length > 0 ? (
        <details className="soc-intel-fields">
          <summary>{t.detailsTitle}</summary>
          <dl>
            {rest.map(([k, v]) => (
              <div key={k}>
                <dt>{k.replace(/_/g, ' ')}</dt>
                <dd><FieldValue value={v} /></dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </section>
  );
}

/* ==========================================================================
 * THE PASSWORD PANEL
 * ========================================================================== */

/**
 * SHA-1 of a string, uppercase hex, computed in the browser.
 *
 * SHA-1 is not a security choice here and could not be: it is the hash the
 * Pwned Passwords corpus is indexed by. Nothing is being protected with it —
 * the whole point is that the first five characters are meant to be public.
 *
 * `crypto.subtle` needs a secure context (HTTPS, or localhost). On a console
 * served over plain HTTP from another machine it is simply absent, and the
 * panel says so rather than quietly offering to send the password instead.
 */
async function sha1Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  try {
    const digest = await subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  } catch {
    return null;
  }
}

function PasswordPanel() {
  const { c } = useI18n();
  const t = c.intel.password;
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function check(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    setError(null);
    if (value === '') {
      setError(t.empty);
      return;
    }
    setBusy(true);
    try {
      const hash = await sha1Hex(value);
      if (hash === null) {
        setError(t.unsupported);
        return;
      }
      const prefix = hash.slice(0, 5);
      const suffix = hash.slice(5);
      const body = await api.pwnedRange(prefix);
      let count = 0;
      for (const line of body.split('\n')) {
        const [candidate, times] = line.trim().split(':');
        if (candidate === suffix) {
          count = Number(times) || 0;
          break;
        }
      }
      setResult({ count });
    } catch (err) {
      // The named reason when there is one — "Pwned Passwords answered 503"
      // tells someone to try later; "the check could not be completed" tells
      // them nothing and reads like their password broke it.
      setError(err instanceof ApiError ? err.message : t.failed);
    } finally {
      setBusy(false);
      // The password is dropped from component state the moment the answer is
      // known. Leaving it in the field means it survives in a React tree, in
      // a form autofill, and on screen behind someone's shoulder.
      setValue('');
      setShow(false);
    }
  }

  return (
    <section className="soc-panel">
      <span className="soc-kicker">{t.kicker}</span>
      {/* Ce que le service EST passe derriere le disque ; ce qu'il PROMET —
          le mot de passe ne quitte pas le navigateur — reste en clair et
          au-dessus du champ. On lit la description une fois, on relit la
          garantie chaque fois qu'on tape un mot de passe. */}
      <div className="soc-titled">
        <h2>{t.title}</h2>
        <Explain label={t.title}>{t.lede}</Explain>
      </div>

      {/* ABOVE the field, deliberately. */}
      <div className="soc-banner soc-banner-ok">
        <Icon name="lock" size={16} />
        <p>{t.neverLeaves}</p>
      </div>

      <form onSubmit={check} className="soc-intel-pwform">
        <label className="soc-field" style={{ flex: 1 }}>
          <span className="soc-intel-label">{t.placeholder}</span>
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t.placeholder}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button type="button" className="soc-secondary" onClick={() => setShow((s) => !s)}>
          {show ? t.hide : t.show}
        </button>
        <button type="submit" className="soc-primary" disabled={busy}>
          <Icon name="search" size={15} /> {busy ? t.checking : t.check}
        </button>
      </form>

      {error ? (
        <div className="soc-banner soc-banner-error">
          <Icon name="alert" size={16} />
          <p>{error}</p>
        </div>
      ) : null}

      {result ? (
        result.count > 0 ? (
          <div className="soc-banner soc-banner-error">
            <Icon name="alert" size={16} />
            <p>
              <b>{t.pwnedTitle}</b> — {t.pwnedText(result.count)} {t.pwnedAdvice}
            </p>
          </div>
        ) : (
          <div className="soc-banner soc-banner-ok">
            <Icon name="check" size={16} />
            <p>
              <b>{t.safeTitle}</b> — {t.safeText}
            </p>
          </div>
        )
      ) : null}
    </section>
  );
}

/* ==========================================================================
 * THE TAB
 * ========================================================================== */

export function IntelPanel({ prefill }: { prefill?: { value: string; n: number } | null }) {
  const { c } = useI18n();
  const t = c.intel;

  const [value, setValue] = useState('');
  const [kind, setKind] = useState<ObservableKind | ''>('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IntelResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<IntelProvider[] | null>(null);
  const [history, setHistory] = useState<Array<{ value: string; verdict: IntelResult['verdict'] }>>([]);
  const [copied, setCopied] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  /**
   * Which request the screen is currently showing.
   *
   * Two lookups can be in flight — Enter submits even while the button is
   * disabled, and "Ask again now" can be clicked over a slow one. Without this
   * the SLOWER answer wins simply by landing last, and the screen ends up
   * showing a verdict for a value the field no longer holds.
   */
  const issued = useRef(0);

  useEffect(() => {
    // Its own request, and a failure here must not take the tab down: the
    // lookup itself works without ever having read this list.
    api.intelProviders().then((r) => setProviders(r.providers)).catch(() => setProviders([]));
  }, []);

  const run = useCallback(async (raw: string, forced: ObservableKind | '' = '', fresh = false) => {
    const query = raw.trim();
    if (query === '') return;
    const mine = ++issued.current;
    setBusy(true);
    setError(null);
    try {
      const r = await api.intelLookup(query, forced === '' ? null : forced, { fresh });
      if (mine !== issued.current) return;
      setResult(r);
      setHistory((h) => [
        { value: r.observable.value, verdict: r.verdict },
        ...h.filter((x) => x.value !== r.observable.value),
      ].slice(0, 12));
    } catch (err) {
      if (mine !== issued.current) return;
      setError(err instanceof ApiError ? err.message : c.errors.load);
    } finally {
      // Only the newest request may put the screen back at rest: an older one
      // finishing would otherwise clear `busy` while a newer one is still out.
      if (mine === issued.current) setBusy(false);
    }
  }, [c.errors.load]);

  // The tab exists to be typed into, and it is reached deliberately — nothing
  // lands here by accident, so taking the caret is the right default. Skipped
  // when a prefill is coming: that path submits on its own, and moving focus
  // as the answer arrives would scroll it out from under the reader.
  // Mount only: the empty dependency list is the point, and re-running it on
  // every render would steal the caret back mid-typing.
  useEffect(() => {
    if (!prefill) input.current?.focus();
  }, []);

  // Arriving from an alert's observable: the value is already the question.
  // Running it immediately is the whole point of the link — landing on a
  // filled field someone still has to submit is a link that saved one click
  // out of two.
  // The counter, not the value, is what makes this fire: asking for the SAME
  // address a second time must re-run it. Keying on the string alone would
  // change no state on the second click, and read as a broken button.
  const lastPrefill = useRef(0);
  useEffect(() => {
    if (!prefill || prefill.n === lastPrefill.current) return;
    lastPrefill.current = prefill.n;
    setValue(prefill.value);
    setKind('');
    void run(prefill.value);
  }, [prefill, run]);

  const relevant = useMemo(() => {
    if (!providers) return [];
    const k = result?.observable.kind;
    // Before anything is looked up, show them all; afterwards, put the ones
    // that had a say in this lookup first.
    if (!k || k === 'unknown') return providers;
    return [...providers].sort((a, b) => Number(b.kinds.includes(k)) - Number(a.kinds.includes(k)));
  }, [providers, result]);

  // Joignable = une cle posee, ou une source qui n'en demande pas. C'est la
  // meme regle que la pastille de chaque fiche, calculee une fois.
  const reachable = relevant.filter((p) => p.env === null || p.configured).length;

  const tone = result ? VERDICT_TONE[result.verdict] : null;

  return (
    <>
      {/* No heading of its own: the tab header above already says LOOKUP, and
          repeating it two lines lower reads as two different screens stacked. */}
      <section className="soc-panel">
        <form
          className="soc-intel-form"
          onSubmit={(e) => {
            e.preventDefault();
            // The submit BUTTON is disabled while a lookup runs; pressing
            // Enter in the field submits the form regardless, which is how a
            // held-down key used to spend four API calls per keypress.
            if (busy) return;
            void run(value, kind);
          }}
        >
          <label className="soc-field" style={{ flex: 1, minWidth: 0 }}>
            {/*
              CET ONGLET S'EXPLIQUAIT TROIS FOIS AVANT QU'ON PUISSE TAPER.
              L'en-tete d'onglet, puis un paragraphe au-dessus du champ, puis
              l'ecran vide juste dessous — trois formulations de la meme chose,
              empilees entre la personne et le champ qu'elle vient remplir.

              Deux restent : l'en-tete, qui dit ce que fait l'onglet, et
              l'ecran vide, qui dit a quelle question il repond — c'est sa
              place. Celle du milieu, la plus mecanique, passe derriere le
              disque de l'etiquette du champ qu'elle decrit.
            */}
            <span className="soc-intel-label">
              {t.fieldLabel} <Explain label={t.fieldLabel}>{t.lede}</Explain>
            </span>
            <input
              ref={input}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t.placeholder}
              spellCheck={false}
              autoComplete="off"
              // 16px in the stylesheet, not here: anything smaller makes iOS
              // zoom the whole page on focus.
            />
          </label>
          <label className="soc-field soc-intel-kind">
            <span className="soc-intel-label">{t.kindForce}</span>
            <select value={kind} onChange={(e) => setKind(e.target.value as ObservableKind | '')}>
              <option value="">{t.kindAuto}</option>
              {(['ipv4', 'ipv6', 'domain', 'url', 'hash', 'email'] as const).map((k) => (
                <option key={k} value={k}>{t.kinds[k]}</option>
              ))}
            </select>
          </label>
          <button type="submit" className="soc-primary" disabled={busy}>
            <Icon name="search" size={15} /> {busy ? t.running : t.run}
          </button>
        </form>

        {result ? (
          <button
            type="button"
            className="soc-secondary soc-icon-button"
            style={{ marginTop: 10 }}
            disabled={busy}
            onClick={() => void run(result.observable.input, kind, true)}
            title={t.freshHint}
          >
            <Icon name="refresh" size={14} /> {t.fresh}
          </button>
        ) : null}
      </section>

      {error ? (
        <div className="soc-banner soc-banner-error">
          <Icon name="alert" size={16} />
          <p>{error}</p>
        </div>
      ) : null}

      {result ? (
        <section className={`soc-panel soc-intel-verdict soc-intel-verdict-${result.verdict}`}>
          <div className="soc-panel-head">
            <div>
              <span className="soc-kicker">{t.kinds[result.observable.kind]}</span>
              <h2 className="soc-intel-value">{result.observable.value}</h2>
            </div>
            <span className={`soc-pill ${tone!.pill}`}>
              <Icon name={tone!.icon} size={14} /> {t.verdicts[result.verdict]}
            </span>
          </div>

          <p className="soc-intel-headline">{result.headline}</p>

          <p className="soc-intel-scope">
            {/* The count of sources that ANSWERED sits with the verdict and
                never below the fold: it is what the verdict means. */}
            <b>{t.answered(result.answered, result.sources.length)}</b>
            <span className="soc-faint"> · {t.took(result.ms)}</span>
            {result.observable.refanged ? <span className="soc-faint"> · {t.refanged}</span> : null}
            {result.observable.input !== result.observable.value ? (
              <span className="soc-faint"> · {t.queriedAs(result.observable.value)}</span>
            ) : null}
          </p>

          {result.observable.private_address === true ? (
            <div className="soc-banner soc-banner-warn">
              <Icon name="alert" size={16} />
              <p>{t.privateNote}</p>
            </div>
          ) : null}

          {result.signals.length > 0 ? (
            <div className="soc-block">
              <h3>{t.signalsTitle}</h3>
              <ul className="soc-intel-signals">
                {result.signals.map((s, i) => (
                  <li key={i} className={`soc-intel-signal soc-intel-signal-${s.weight}`}>
                    <Icon name={s.weight === 'strong' ? 'alert' : s.weight === 'weak' ? 'clock' : 'check'} size={14} />
                    <span>
                      {s.text} <span className="soc-faint">— {s.provider}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <button
            type="button"
            className="soc-secondary soc-icon-button"
            onClick={() => {
              void navigator.clipboard?.writeText(JSON.stringify(result, null, 2));
              setCopied(true);
              setTimeout(() => setCopied(false), 2500);
            }}
          >
            <Icon name="code" size={14} /> {copied ? t.copied : t.copy}
          </button>
        </section>
      ) : (
        <section className="soc-panel">
          <h2>{t.emptyTitle}</h2>
          <p className="soc-muted">{t.emptyLede}</p>
          <h3>{t.examplesTitle}</h3>
          <ul className="soc-intel-examples">
            {t.examples.map((ex) => (
              <li key={ex.value}>
                <button
                  type="button"
                  className="soc-chip"
                  onClick={() => {
                    setValue(ex.value);
                    setKind('');
                    void run(ex.value);
                  }}
                >
                  {ex.value}
                </button>
                <span className="soc-faint">{ex.what}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result ? result.sources.map((s) => <SourceCard key={s.provider} source={s} />) : null}

      <PasswordPanel />

      {history.length > 0 ? (
        <section className="soc-panel">
          <span className="soc-kicker">{t.historyTitle}</span>
          <p className="soc-muted">{t.historyLede}</p>
          <ul className="soc-intel-history">
            {history.map((h) => (
              <li key={h.value}>
                <span className={`soc-pill ${VERDICT_TONE[h.verdict].pill}`}>{t.verdicts[h.verdict]}</span>
                <button
                  type="button"
                  className="soc-chip"
                  onClick={() => {
                    setValue(h.value);
                    setKind('');
                    void run(h.value);
                  }}
                >
                  {h.value}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        LE CATALOGUE DES SOURCES EST DE LA REFERENCE, ET SON PLI EST UN
        RAPPORT.

        Sept fiches — ce que chaque source apporte, ce qu'elle couvre, sa
        variable de cle — soit huit cents pixels lus une fois, au moment de
        poser les cles. Repliees, elles laissent le champ et le resultat
        occuper l'ecran.

        Mais le pli ne se contente pas de compter : il dit COMBIEN DE SOURCES
        REPONDRONT. Sur une installation sans cle, c'est le fait le plus utile
        de cet ecran — il annonce d'avance que chaque resultat sera « pas
        demande » plutot que « rien trouve ». Et quand aucune ne repond, le
        pli s'ouvre : ranger ca derriere un clic silencieux serait afficher
        vert une couverture nulle, ce que cet onglet refuse dans ses propres
        verdicts.
      */}
      <section className="soc-panel">
        <Fold
          title={t.providersTitle}
          hint={providers === null ? undefined : t.providersReady(reachable, relevant.length)}
          defaultOpen={providers !== null && reachable === 0}
        >
        <p className="soc-muted">{t.providersLede}</p>
        {providers === null ? (
          <p className="soc-empty">{c.common.loading}</p>
        ) : (
          <ul className="soc-intel-providers">
            {relevant.map((p) => (
              <li key={p.id}>
                <div className="soc-intel-provider-head">
                  <b>{p.label}</b>
                  <span className={`soc-pill ${p.configured ? 'soc-pill-ok' : 'soc-pill-info'}`}>
                    {p.env === null ? t.freeSource : p.configured ? t.ready : t.noKey}
                  </span>
                </div>
                <p className="soc-muted">{p.purpose}</p>
                <p className="soc-faint">
                  {t.covers}: {p.kinds.map((k) => t.kinds[k]).join(', ')} · {t.keptFor(p.ttl_hours)}
                  {p.env ? ` · ${p.env}` : ''}
                </p>
                {!p.configured ? (
                  <a href={p.signup} target="_blank" rel="noreferrer noopener" className="soc-secondary soc-icon-button">
                    <Icon name="external" size={14} /> {t.getKey}
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <p className="soc-faint">{t.goSettings}</p>
        </Fold>
      </section>
    </>
  );
}
