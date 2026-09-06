/**
 * Settings → MCP: opening this console to other AI tools.
 *
 * ============================================================================
 * THE SCREEN EXISTS BECAUSE THE ALTERNATIVE WAS A README
 *
 * Everything here could have been three sentences of documentation and a
 * hand-edited JSON file. That is exactly how the previous version of this
 * feature was installed, and it is why installing it took an hour: you invent a
 * token, you paste it in two places, you get the URL wrong because the README
 * says `localhost` and you are setting it up on someone else's machine.
 *
 * ============================================================================
 * FOUR DECISIONS THAT MAKE IT PLUG-AND-PLAY
 *
 *  1. THE URL IS GENERATED FROM THE ADDRESS YOU REACHED THE CONSOLE ON. Not
 *     retyped from documentation. Install this on a colleague's machine and the
 *     block says their host, because that is the host their browser used. This
 *     is the same rule the Ingestion tab already follows, for the same reason.
 *
 *  2. THE TOKEN IS GENERATED HERE, AND SHOWN ONCE. Asking someone to produce 32
 *     random bytes by hand produces `menater2024`. It is displayed exactly once,
 *     said plainly, and the config blocks below are filled in with it while it
 *     is on screen — which is the only moment a copy-paste can be complete.
 *
 *  3. FOUR CLIENTS, EACH IN ITS OWN FORM. Claude Desktop needs a JSON file and
 *     the stdio bridge; Claude Code takes one command; Cursor and VS Code have
 *     their own shapes. Offering one and calling the rest "similar" is what
 *     turns a five-minute setup into an afternoon.
 *
 *  4. THE TEST BUTTON TESTS THE REAL PATH, from the server, over the loopback
 *     socket. It cannot run from the browser — the Origin guard refuses
 *     browsers on purpose — and a test that quietly checked something easier
 *     would be worse than no test.
 * ============================================================================
 */

import { useCallback, useEffect, useState } from 'react';

import { Icon } from './Icon.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useI18n } from '../i18n/context.tsx';
import type { McpState } from '../lib/types.ts';

/** A block of text with a copy button. The only interaction this page needs. */
function CopyBlock({ text, label }: { text: string; label: string }) {
  const { c } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (insecure origin, permission). The text
      // is on screen and selectable either way, so this fails quietly rather
      // than throwing an error over a convenience.
    }
  }

  return (
    <div className="soc-mcp-block">
      <div className="soc-mcp-block-head">
        <span className="soc-kicker">{label}</span>
        <button type="button" className="soc-mcp-copy" onClick={copy}>
          <Icon name={copied ? 'check' : 'chain'} size={14} />
          {copied ? c.mcp.copied : c.mcp.copy}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

/** Ordre d'apparition, et cle de libelle. Ferme : voir le commentaire d'en-tete. */
const CLIENTS = ['desktop', 'code', 'cursor', 'vscode'] as const;
type ClientId = (typeof CLIENTS)[number];

const CLIENT_LABEL: Record<ClientId, 'clientClaudeDesktop' | 'clientClaudeCode' | 'clientCursor' | 'clientVsCode'> = {
  desktop: 'clientClaudeDesktop',
  code: 'clientClaudeCode',
  cursor: 'clientCursor',
  vscode: 'clientVsCode',
};

export function McpPanel({
  settings,
  onToggle,
  busy,
}: {
  /**
   * Only the switch. NOT `Settings['assistant']`: that type also carries
   * `mcpTokenSet`, a display flag the page's draft deliberately does not hold,
   * and asking for the whole object would drag that decision back in here.
   */
  settings: { mcpEnabled: boolean };
  /** Writes `mcpEnabled` through the page's own save path. */
  onToggle: (enabled: boolean) => void;
  busy: boolean;
}) {
  const { c } = useI18n();
  const t = c.mcp;

  const [state, setState] = useState<McpState | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null);
  // Claude Desktop d'abord : c'est le seul des quatre qui demande un pont, donc
  // celui ou l'on se trompe. Le choix ne se retient pas — il vaut pour la duree
  // de l'installation, qui tient dans une visite.
  const [client, setClient] = useState<ClientId>('desktop');
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.mcpState().then(setState).catch(() => setState(null));
  }, []);

  useEffect(load, [load]);

  /**
   * The address a client outside the browser must use.
   *
   * `window.location.origin` is the one thing that is certainly right: it is
   * how this very page was served. A client on the SAME machine can use it as
   * is; a client elsewhere needs a hostname rather than `localhost`, which the
   * note below says rather than leaving it to be discovered.
   */
  const endpoint = `${window.location.origin}${state?.path ?? '/api/mcp'}`;
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  const shownToken = token ?? '<your token>';

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const r = await api.mcpGenerateToken();
      setToken(r.token);
      setTest(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t.generateFailed);
    } finally {
      setGenerating(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.mcpTest());
    } catch (err) {
      setTest({ ok: false, detail: err instanceof ApiError ? err.message : t.testFailed });
    } finally {
      setTesting(false);
    }
  }

  const claudeDesktop = JSON.stringify(
    {
      mcpServers: {
        menater: {
          command: 'npx',
          args: [
            '-y',
            'mcp-remote@0.8.3',
            endpoint,
            '--transport',
            'http-only',
            ...(endpoint.startsWith('http://') ? ['--allow-http'] : []),
            '--header',
            'Authorization:${AUTH_HEADER}',
          ],
          env: { AUTH_HEADER: `Bearer ${shownToken}` },
        },
      },
    },
    null,
    2,
  );

  const claudeCode = `claude mcp add --transport http menater ${endpoint} \\\n  --header "Authorization: Bearer ${shownToken}"`;

  const cursor = JSON.stringify(
    {
      mcpServers: {
        menater: { url: endpoint, headers: { Authorization: `Bearer ${shownToken}` } },
      },
    },
    null,
    2,
  );

  const vscode = JSON.stringify(
    {
      servers: {
        menater: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${shownToken}` } },
      },
    },
    null,
    2,
  );

  return (
    <section className="soc-panel">
      <div className="soc-panel-head">
        <div>
          <span className="soc-kicker">{t.kicker}</span>
          <h2>{t.title}</h2>
        </div>
        <span className={`soc-pill ${state?.live ? 'soc-pill-ok' : 'soc-pill-warn'}`}>
          {state?.live ? t.statusLive : t.statusOff}
        </span>
      </div>
      <p className="soc-muted">{t.lede}</p>

      {/* --- Step 1: the switch ------------------------------------------- */}
      <h3 className="soc-mcp-step">{t.step1}</h3>
      <label className="soc-check">
        <input
          type="checkbox"
          checked={settings.mcpEnabled}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={busy}
        />
        <span>{t.enable}</span>
      </label>
      <p className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
        {t.enableHelp}
      </p>

      {/* --- Step 2: the token -------------------------------------------- */}
      <h3 className="soc-mcp-step">{t.step2}</h3>
      <p className="soc-muted">{state?.token_set ? t.tokenSet : t.tokenMissing}</p>
      <div className="soc-actions">
        <button type="button" className="soc-primary" onClick={generate} disabled={generating}>
          <Icon name="lock" size={15} />
          {generating ? c.common.saving : state?.token_set ? t.regenerate : t.generate}
        </button>
      </div>
      {state?.token_set ? <p className="soc-faint">{t.regenerateWarning}</p> : null}
      {error ? (
        <div className="soc-banner soc-banner-error">
          <Icon name="alert" size={16} />
          <p>{error}</p>
        </div>
      ) : null}

      {token ? (
        <>
          <div className="soc-banner soc-banner-ok">
            <Icon name="alert" size={16} />
            <p>{t.tokenOnce}</p>
          </div>
          <CopyBlock label={t.tokenLabel} text={token} />
        </>
      ) : null}

      {/* --- Step 3: the client -------------------------------------------- */}
      <h3 className="soc-mcp-step">{t.step3}</h3>
      {!token && state?.token_set ? <p className="soc-warn-note">{t.placeholderNote}</p> : null}
      {isLoopback ? <p className="soc-faint">{t.loopbackNote}</p> : null}

      {/*
        UN client a la fois.
        ====================================================================
        LA REGLE N'A PAS BOUGE : les quatre clients gardent chacun leur forme
        complete — le pont stdio de Claude Desktop, la commande unique de
        Claude Code, les deux JSON. « N'en proposer qu'un et dire que les
        autres sont similaires » transforme cinq minutes en apres-midi, et
        c'est toujours interdit.

        Ce qui change, c'est qu'on n'en montre qu'un A LA FOIS. On installe
        sur UN client : les trois autres blocs etaient toujours du bruit, et
        ils poussaient l'etape 4 — le bouton qui prouve que ca marche — hors
        de l'ecran. Les quatre sont la, nommes, a un clic.
      */}
      <div className="soc-field">
        <span>{t.pickClient}</span>
        <div className="soc-lang soc-lang-wide" role="group" aria-label={t.pickClient}>
          {CLIENTS.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setClient(id)}
              aria-pressed={client === id}
            >
              {t[CLIENT_LABEL[id]]}
            </button>
          ))}
        </div>
      </div>

      <CopyBlock
        label={t[CLIENT_LABEL[client]]}
        text={
          client === 'desktop'
            ? claudeDesktop
            : client === 'code'
              ? claudeCode
              : client === 'cursor'
                ? cursor
                : vscode
        }
      />
      {/* Le chemin du fichier ne vaut que pour Claude Desktop : affiche sous
          les trois autres, il envoyait editer un fichier qui n'existe pas. */}
      {client === 'desktop' ? (
        <p className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
          {t.claudeDesktopPath}
        </p>
      ) : null}

      {/* --- Step 4: proof ------------------------------------------------- */}
      <h3 className="soc-mcp-step">{t.step4}</h3>
      <div className="soc-actions">
        <button type="button" className="soc-secondary" onClick={runTest} disabled={testing}>
          <Icon name="activity" size={15} />
          {testing ? t.testing : t.test}
        </button>
      </div>
      {test ? (
        <div className={`soc-banner ${test.ok ? 'soc-banner-ok' : 'soc-banner-error'}`}>
          <Icon name={test.ok ? 'check' : 'alert'} size={16} />
          <p>{test.detail}</p>
        </div>
      ) : null}

      {/* --- What they are actually opening -------------------------------- */}
      {state ? (
        <>
          <h3 className="soc-mcp-step">{t.exposes}</h3>
          <p className="soc-muted">{t.readOnly}</p>
          <div className="soc-mcp-catalogue">
            <div>
              <span className="soc-kicker">{t.tools(state.tools.length)}</span>
              <p className="soc-faint">{state.tools.join(', ')}</p>
            </div>
            <div>
              <span className="soc-kicker">{t.prompts(state.prompts.length)}</span>
              <p className="soc-faint">{state.prompts.map((p) => p.title).join(' · ')}</p>
            </div>
            <div>
              <span className="soc-kicker">{t.resources(state.resources.length)}</span>
              <p className="soc-faint">{state.resources.join(' · ')}</p>
            </div>
          </div>
          <p className="soc-faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {t.tokenIsAccess}
          </p>
        </>
      ) : null}
    </section>
  );
}
