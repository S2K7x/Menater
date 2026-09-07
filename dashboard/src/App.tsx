/**
 * MENATER — console d'orchestration.
 *
 * ============================================================================
 * SEPT DESTINATIONS, UNE SEULE APPLICATION
 *
 *   Alertes  — ce qui est déjà arrivé, trié par ce qui bloque un humain ;
 *   Code     — ce qui va arriver : les failles encore dans le code ;
 *   Suivi    — les exécutions derrière les alertes, y compris celles qui n'ont
 *              produit aucun cas ;
 *   Mesures  — les deux taux qui décident du passage en mode réel ;
 *   Santé    — le diagnostic de bout en bout du pipeline ;
 *   Guide    — la documentation de tout ce qui précède ;
 *   Réglages — tous les réglages, y compris ceux de l'analyse de code.
 *
 * ============================================================================
 * TROIS CHOIX DE STRUCTURE QUI COMPTENT
 *
 *  1. AUCUN ONGLET DANS UN ONGLET. L'analyse de code avait autrefois sa propre
 *     barre (présentation / analyse / réglages). Ses trois destinations ont
 *     rejoint celles de la console. Une hiérarchie à deux niveaux fait perdre
 *     quelqu'un qui découvre l'outil, et double les endroits où chercher.
 *
 *  2. L'ONGLET CODE RESTE MONTÉ. Il tient un scan en cours et un flux
 *     d'événements ; le démonter en changeant d'onglet couperait l'analyse.
 *     Il n'est en revanche monté qu'à la PREMIÈRE visite : une console ouverte
 *     sur la file d'alertes n'a aucune raison de réveiller le moteur.
 *
 *  3. IL EST CHARGÉ À LA DEMANDE (`lazy`). C'est la moitié du poids de
 *     l'application ; quelqu'un qui ne fait que du triage ne le télécharge
 *     jamais.
 * ============================================================================
 */

import { Fragment, Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';

import { AlertQueue } from './components/AlertQueue.tsx';
import { CaseView } from './components/CaseView.tsx';
import { MetricsPanel, StatBar } from './components/MetricsPanel.tsx';
import { HealthPanel } from './components/HealthPanel.tsx';
import { TracePanel } from './components/TracePanel.tsx';
import { IngestionPanel } from './components/IngestionPanel.tsx';
import { SettingsPage } from './components/SettingsPage.tsx';
import { NoticeList } from './components/Notices.tsx';
import { RulesPage } from './components/RulesPage.tsx';
import { DocsPanel } from './components/DocsPanel.tsx';
import { IntelPanel } from './components/IntelPanel.tsx';
import { Assistant } from './components/Assistant.tsx';
import { FirstRun, PageHead, SectionBoundary } from './components/Guidance.tsx';
import { Icon, type IconName } from './components/Icon.tsx';
import { Mark } from './components/Mark.tsx';
import { api, ApiError, AuthRequiredError } from './lib/api.ts';
import { consoleDictionary } from './i18n/console.ts';
import { getCurrentLocale, useI18n } from './i18n/context.tsx';
import type { ConsoleSnapshot } from './lib/types.ts';

// Chargés à la demande : l'analyse de code pèse plus lourd que tout le reste
// de la console réuni.
const VulnPipeSection = lazy(() =>
  import('./vulnpipe/VulnPipeSection.tsx').then((m) => ({ default: m.VulnPipeSection })),
);
const VulnPipeSettings = lazy(() =>
  import('./vulnpipe/VulnPipeSection.tsx').then((m) => ({ default: m.VulnPipeSettings })),
);

type Tab = 'queue' | 'code' | 'ingestion' | 'rules' | 'trace' | 'metrics' | 'health' | 'intel' | 'docs' | 'settings';

/**
 * Onglets qui lisent le snapshot du pipeline. `code` n'en fait pas partie : il
 * a sa propre source. La liste sert aux bandeaux d'erreur et a l'ecran de
 * chargement, qui n'ont rien a dire ailleurs.
 */
const PIPELINE_TABS: Tab[] = ['queue', 'trace', 'metrics', 'health'];


/**
 * Écran de connexion.
 *
 * Il n'affiche jamais pourquoi la tentative échoue au-delà de « mot de passe
 * incorrect » : distinguer « aucun mot de passe configuré » de « mauvais mot de
 * passe » renseignerait un attaquant sur l'état de l'installation.
 */
function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const { c } = useI18n();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      setPassword('');
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : c.login.unavailable);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="soc-app soc-login">
      <div className="soc-logo" style={{ marginBottom: 26 }}>
        <span className="soc-logo-sign">
          <Mark size={30} title="MENATER" />
        </span>
        <span className="soc-logo-mark">MENATER</span>
        <span className="soc-logo-word">
          Security
          <br />
          Operations
        </span>
      </div>
      <section className="soc-panel">
        <span className="soc-kicker">{c.login.kicker}</span>
        <h2>{c.login.title}</h2>
        <form onSubmit={submit}>
          <label className="soc-field">
            <span>{c.login.password}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
            />
          </label>
          {error ? (
            <div className="soc-banner soc-banner-error">
              <Icon name="alert" size={16} />
              <p>{error}</p>
            </div>
          ) : null}
          <button type="submit" className="soc-primary" disabled={busy || password === ''}>
            <Icon name="lock" size={15} />
            {busy ? c.login.submitting : c.login.submit}
          </button>
        </form>
        <p className="soc-faint" style={{ marginTop: 14 }}>
          {c.login.note}
        </p>
      </section>
    </div>
  );
}

/**
 * The lockup: the mark, then the wordmark, then what the product is.
 *
 * Both halves are drawn, not loaded — nothing to download, nothing that breaks
 * offline, and both take the theme's accent from the tokens rather than from a
 * second asset somebody has to remember to redraw. The mark's `fill` is
 * `currentColor`, so switching theme in Settings recolours it with the rest of
 * the screen and no code runs.
 *
 * The word carries the accessible name; the mark is decorative beside it, so
 * a screen reader announces "MENATER" once rather than twice.
 */
function Logo() {
  return (
    <div className="soc-logo">
      <span className="soc-logo-sign">
        <Mark size={30} />
      </span>
      <span className="soc-logo-mark">MENATER</span>
      <span className="soc-logo-word">
        Security
        <br />
        Operations
      </span>
    </div>
  );
}

const DEFAULT_REFRESH_S = 20;

export function App() {
  const { c, locale } = useI18n();
  const [tab, setTab] = useState<Tab>('queue');
  // L'analyse de code n'est montée qu'à la première visite de son onglet. Une
  // fois montée, elle le reste : la démonter couperait un scan en cours.
  const [codeMounted, setCodeMounted] = useState(false);
  // Section du Guide a deplier quand on y arrive depuis « Comment ca marche ? ».
  const [docsSection, setDocsSection] = useState<string | null>(null);
  /**
   * The value the Lookup tab should open on. Carries a counter suffix so that
   * asking for the SAME address twice still re-runs it: without it the second
   * click on the same observable would change no state and look broken.
   */
  const [intelPrefill, setIntelPrefill] = useState<{ value: string; n: number } | null>(null);
  /**
   * The target the Code tab should open on, from an incident card (J0.3).
   *
   * Same counter trick as `intelPrefill`, and it earns it twice over here: the
   * Code tab stays MOUNTED once opened, so a launcher already on screen would
   * keep the field it was rendered with. The counter re-keys it.
   */
  const [codePrefill, setCodePrefill] = useState<{ target: string; n: number } | null>(null);
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // null = on ne sait pas encore ; false = verrou actif, connexion requise.
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [authEnabled, setAuthEnabled] = useState(false);
  // Évite qu'un rafraîchissement automatique arrive après le démontage et
  // écrase un état plus récent choisi par l'utilisateur.
  const alive = useRef(true);
  // Un chargement deja parti. L'horloge de rafraichissement ne l'attend pas :
  // si le snapshot met plus longtemps que la cadence a revenir — le cas
  // pendant une reconstruction froide — les demandes s'empilaient, chacune
  // ralentissant les autres, et la derniere arrivee ecrasait la plus recente.
  const pending = useRef(false);

  const load = useCallback(async (force = false) => {
    // Un rafraichissement EXPLICITE (bouton, changement de langue) prime : on
    // le laisse partir meme si l'automatique tourne encore, sinon le clic
    // n'aurait aucun effet visible.
    if (pending.current && !force) return;
    pending.current = true;
    setRefreshing(true);
    try {
      const snap = await api.snapshot(force);
      if (!alive.current) return;
      setSnapshot(snap);
      setError(null);
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof AuthRequiredError) {
        // Le verrou a été activé ailleurs, ou la session a expiré : on repasse
        // par l'écran de connexion plutôt que d'afficher une erreur cryptique.
        setAuthed(false);
        setError(null);
        return;
      }
      // Catalogue relu au moment de l'echec, pas capture a la creation du
      // callback : garder `load` stable evite qu'un changement de langue
      // relance l'effet de montage — et donc un double chargement.
      setError(
        err instanceof ApiError ? err.message : consoleDictionary(getCurrentLocale()).errors.load,
      );
    } finally {
      pending.current = false;
      if (alive.current) setRefreshing(false);
    }
  }, []);

  const checkAuth = useCallback(async () => {
    try {
      const st = await api.authStatus();
      setAuthEnabled(st.enabled);
      setAuthed(st.authenticated);
      return st.authenticated;
    } catch {
      // Si le statut lui-même est injoignable, l'API est morte : on laisse
      // l'écran principal afficher son erreur plutôt que l'écran de connexion.
      setAuthed(true);
      return true;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void checkAuth().then((ok) => {
      if (ok) void load();
    });
    return () => {
      alive.current = false;
    };
  }, [checkAuth, load]);

  // Le serveur redige une partie de ce qui s'affiche : notes de chaine de
  // traitement, constats bloquants, jeu d'exemple. Changer de langue doit donc
  // RELIRE le snapshot, pas seulement retraduire les libelles — sinon la file
  // reste dans l'ancienne langue jusqu'au prochain rafraichissement.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (authed !== false) void load(true);
  }, [locale, authed, load]);

  // La cadence vient des réglages : la changer ne doit pas demander un
  // rechargement. On suspend l'horloge sur l'onglet Code : rafraîchir des
  // alertes qu'on ne regarde pas, pendant un scan, c'est de la charge inutile
  // sur le pipeline et un rendu de plus au milieu d'un flux d'événements.
  const refreshSeconds = snapshot?.refresh_seconds ?? DEFAULT_REFRESH_S;
  useEffect(() => {
    if (authed === false || tab === 'code') return undefined;
    const timer = setInterval(() => void load(), refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [load, refreshSeconds, authed, tab]);

  if (authed === false) {
    return (
      <LoginScreen
        onSuccess={() => {
          setAuthed(true);
          void load(true);
        }}
      />
    );
  }

  const cases = snapshot?.cases ?? [];
  const selectedCase = selected ? (cases.find((x) => x.alert_id === selected) ?? null) : null;
  const blocked = cases.filter((x) => x.state === 'awaiting_approval').length;
  const failing = snapshot ? snapshot.health.blocking_findings.length : 0;
  const lost = snapshot?.trace.counts.attention ?? 0;

  /**
   * Dix onglets, quatre groupes.
   *
   * ==========================================================================
   * POURQUOI GROUPER PLUTOT QUE RACCOURCIR
   *
   * Une barre de dix boutons identiques se parcourt en dix comparaisons : rien
   * ne dit lesquels vont ensemble, donc rien ne permet d'en ecarter huit d'un
   * coup. Ce n'est pas une limite de MEMOIRE — les libelles sont a l'ecran,
   * personne ne les retient — c'est un cout de DECISION, et le remede y est la
   * categorisation, pas l'amputation : aucun onglet ne disparait.
   *
   * Les groupes sont separes par un simple trait. Pas de titre, pas de
   * sous-menu : un second niveau de navigation redonnerait ici ce qu'on vient
   * d'economiser, et la regle « aucun onglet dans un onglet » tient toujours.
   *
   *   1. LE TRAVAIL       — ce qu'on vient faire : trier, analyser.
   *   2. LE SYSTEME       — comment il travaille, et ce qu'il a produit.
   *   3. LES OUTILS       — ce qu'on va chercher soi-meme, ponctuellement.
   *   4. LA REFERENCE     — ce qu'on ouvre rarement, et qu'on veut trouver
   *                         toujours au meme endroit.
   * ==========================================================================
   */
  const tabs: Array<{ id: Tab; label: string; icon: IconName; count?: number; group: number }> = [
    { id: 'queue', label: c.nav.alerts, icon: 'queue', count: blocked, group: 1 },
    { id: 'code', label: c.nav.code, icon: 'code', group: 1 },
    // Juste apres Code : les deux onglets qui montrent COMMENT le systeme
    // travaille, avant ceux qui montrent ce qu'il a produit.
    //
    // « Ingestion » PLUTOT QUE « Workflow ». Le mot designait la machinerie et
    // pas la question : sur ce produit il veut deja dire trois choses —
    // l'editeur n8n, les six sous-workflows, le moteur integre — et quelqu'un
    // qui cherchait « comment mes alertes arrivent » n'avait aucune raison de
    // cliquer dessus. Le graphe n'a pas disparu : il est la troisieme section
    // de l'onglet, la ou « ce qui se passe une fois l'alerte arrivee » se lit
    // dans la suite de « comment elle arrive ».
    { id: 'ingestion', label: c.nav.ingestion, icon: 'chain', group: 2 },
    // Le compteur porte les chaines rompues, les chaines a l'arret et les
    // executions rattachees a rien. C'est le seul endroit ou ces trois pannes
    // se voient : sans pastille, il faudrait penser a ouvrir l'onglet.
    { id: 'trace', label: c.nav.trace, icon: 'chain', count: lost, group: 2 },
    { id: 'metrics', label: c.nav.metrics, icon: 'activity', group: 2 },
    { id: 'rules', label: c.nav.rules, icon: 'sliders', group: 2 },
    { id: 'health', label: c.nav.health, icon: 'shield', count: failing, group: 3 },
    // No counter, and there should not be one: this tab produces nothing that
    // waits for anybody. It is a question you come and ask.
    { id: 'intel', label: c.nav.intel, icon: 'search', group: 3 },
    { id: 'docs', label: c.nav.docs, icon: 'book', group: 4 },
    { id: 'settings', label: c.nav.settings, icon: 'sliders', group: 4 },
  ];

  const openTab = (id: Tab) => {
    if (id === 'code') setCodeMounted(true);
    setDocsSection(null);
    setTab(id);
  };

  /**
   * From an alert's observable to the Lookup tab, question already asked.
   *
   * This is the smallest version of what § 2 of the roadmap calls for: the two
   * halves of the console talking. An analyst reading a case had to select an
   * address, change tab and paste it; now the case hands it over.
   */
  const lookUp = (observable: string) => {
    setIntelPrefill((prev) => ({ value: observable, n: (prev?.n ?? 0) + 1 }));
    setDocsSection(null);
    setTab('intel');
  };

  /**
   * From an alert to the code that runs on the machine it is about (J0.3).
   *
   * The other half of the pair above, and the first thing in this console that
   * carries something from the SOC side to the analysis side. It fills the
   * launcher in and stops there — a scan costs money and is a human's click,
   * so nothing is estimated and nothing is started.
   */
  const analyse = (repository: string) => {
    setCodePrefill((prev) => ({ target: repository, n: (prev?.n ?? 0) + 1 }));
    setCodeMounted(true);
    setDocsSection(null);
    setTab('code');
  };

  /**
   * « Comment ca marche ? » : on ouvre le Guide SUR la section qui explique
   * l'onglet qu'on quitte. Un lien d'aide qui atterrit en haut d'une page de
   * huit sections repliees ne repond a rien.
   */
  const openGuide = (section: string) => {
    setDocsSection(section);
    setTab('docs');
  };

  return (
    <div className="soc-app">
      <header className="soc-header">
        <Logo />

        <nav className="soc-nav" aria-label={c.nav.sections}>
          {tabs.map((entry, i) => (
            <Fragment key={entry.id}>
              {/* Purement visuel, et donc `aria-hidden` : un lecteur d'ecran
                  annonce deja dix boutons dans une region nommee, et un trait
                  de plus n'y ajoute rien. */}
              {i > 0 && tabs[i - 1]!.group !== entry.group ? (
                <span className="soc-nav-sep" aria-hidden="true" />
              ) : null}
              <button
                type="button"
                className={`soc-tab ${tab === entry.id ? 'soc-tab-active' : ''}`}
                aria-current={tab === entry.id ? 'page' : undefined}
                onClick={() => openTab(entry.id)}
              >
                <Icon name={entry.icon} size={14} />
                <span className="soc-tab-label">{entry.label}</span>
                {entry.count ? <span className="soc-tab-count soc-tab-count-alert">{entry.count}</span> : null}
              </button>
            </Fragment>
          ))}
        </nav>

        <div className="soc-header-tools">
          {/* Pas de pastille « réel » : dire en permanence que tout est
              normal n'apprend rien, et occupe la place où l'anormal devrait
              se voir. Le mode démonstration, lui, reste annoncé — par le
              bandeau au-dessus de la file et par l'onglet Santé, qui en
              donnent aussi la RAISON. */}
          {/* LE SÉLECTEUR DE LANGUE VIT DANS LES RÉGLAGES, PAS ICI.
              C'est un choix qu'on fait une fois : lui garder une place
              permanente en tête de CHAQUE écran, à côté du rafraîchissement,
              lui donnait le même poids visuel qu'une commande qu'on utilise
              vingt fois par jour. Il reste sur l'écran de connexion, où les
              Réglages ne sont pas atteignables. */}
          <button
            type="button"
            className="soc-secondary soc-icon-button"
            onClick={() => void load(true)}
            disabled={refreshing}
            aria-label={c.header.refresh}
            title={c.header.refresh}
          >
            <Icon name="refresh" size={14} />
            <span className="soc-tab-label">{refreshing ? c.header.refreshing : c.header.refresh}</span>
          </button>
          {authEnabled ? (
            <button
              type="button"
              className="soc-secondary soc-icon-button"
              aria-label={c.header.leave}
              title={c.header.leave}
              onClick={async () => {
                await api.logout().catch(() => undefined);
                setAuthed(false);
              }}
            >
              <Icon name="lock" size={14} />
              <span className="soc-tab-label">{c.header.leave}</span>
            </button>
          ) : null}
        </div>
      </header>

      {/* Les deux bandeaux parlent du pipeline d'alertes : ils n'ont rien à
          dire sur l'analyse de code, la documentation ou les réglages. */}
      {/* Acquittables ensemble : sur la file, ces deux bandeaux reviennent à
          CHAQUE rafraîchissement — toutes les vingt secondes par défaut — et
          répètent un état qu'on a déjà lu. Le bandeau d'erreur, lui, n'est pas
          acquittable une fois pour toutes : son texte porte la cause, et une
          cause différente est un message différent, donc non lu. */}
      <div style={{ marginTop: 20 }}>
        <NoticeList
          notices={[
            ...(error && PIPELINE_TABS.includes(tab)
              ? [{ scope: `app.error.${tab}`, tone: 'error' as const, text: error }]
              : []),
            ...(snapshot?.health.mode === 'demo'
              && (tab === 'queue' || tab === 'trace' || tab === 'metrics')
              ? [{
                scope: 'app.demo',
                tone: 'warn' as const,
                title: c.demoBanner.title,
                text: c.demoBanner.text,
              }]
              : []),
          ]}
        />
      </div>

      {/* L'analyse de code ne lit pas le pipeline d'alertes : elle ne doit donc
          pas être prise dans l'écran d'erreur du snapshot. Elle est rendue à
          côté, et cachée — pas démontée — quand un autre onglet est actif. */}
      {codeMounted ? (
        <main hidden={tab !== 'code'}>
          <PageHead
            kicker={c.pageHead.code.kicker}
            title={c.pageHead.code.title}
            lede={c.pageHead.code.lede}
            onGuide={() => openGuide('code')}
          />
          <SectionBoundary>
            <Suspense fallback={<p className="soc-empty">{c.common.loading}</p>}>
              <VulnPipeSection prefill={codePrefill} />
            </Suspense>
          </SectionBoundary>
        </main>
      ) : null}

      {tab === 'code' ? null : !snapshot && PIPELINE_TABS.includes(tab) ? (
        error ? (
          // Sans ce cas, un échec de chargement laissait « Chargement… » à
          // l'écran indéfiniment : l'utilisateur ne pouvait pas distinguer une
          // console lente d'une console morte.
          <section className="soc-panel">
            <span className="soc-kicker">{c.errors.load}</span>
            <h2>{c.errors.nothingLoaded}</h2>
            <p className="soc-muted">{c.errors.nothingLoadedLede}</p>
            <button type="button" className="soc-primary" onClick={() => void load(true)} disabled={refreshing}>
              <Icon name="refresh" size={15} />
              {refreshing ? c.common.retrying : c.common.retry}
            </button>
          </section>
        ) : (
          <p className="soc-empty">{c.common.loading}</p>
        )
      ) : (
        <main>
          {tab === 'queue' && snapshot ? (
            <>
              {selectedCase ? null : (
                <>
                  <PageHead
                    kicker={c.pageHead.alerts.kicker}
                    title={c.pageHead.alerts.title}
                    lede={c.pageHead.alerts.lede}
                    onGuide={() => openGuide('queue')}
                  >
                    {/* La reponse a « est-ce que quelque chose m'attend ? » est
                        la premiere chose qu'on vient chercher : elle est ecrite
                        en toutes lettres, pas deduite d'un compteur. */}
                    <p className={blocked > 0 ? 'soc-waiting soc-waiting-on' : 'soc-waiting'}>
                      <Icon name={blocked > 0 ? 'alert' : 'check'} size={15} />
                      {blocked > 0 ? c.queue.waitingOnYou(blocked) : c.queue.nothingWaiting}
                    </p>
                  </PageHead>
                  <FirstRun onGo={(target) => (target === 'docs' ? openGuide('overview') : openTab(target))} />
                </>
              )}
              <StatBar metrics={snapshot.metrics} />
              {selectedCase ? (
                <>
                  <button
                    type="button"
                    className="soc-secondary"
                    style={{ marginBottom: 18 }}
                    onClick={() => setSelected(null)}
                  >
                    <Icon name="queue" size={14} /> {c.queue.back}
                  </button>
                  <CaseView
                    alertCase={selectedCase}
                    onRefresh={() => void load(true)}
                    onLookUp={lookUp}
                    onAnalyse={analyse}
                  />
                </>
              ) : (
                <AlertQueue cases={cases} selectedId={selected} onSelect={setSelected} />
              )}
            </>
          ) : null}

          {/* L'onglet Ingestion ne lit PAS le snapshot : il decrit comment les
              alertes entrent et ce qui les traite, pas ce qui en est sorti. Il
              reste donc consultable quand n8n — ou la base — est injoignable,
              ce qui est precisement le moment ou on veut comprendre comment le
              systeme est cable. */}
          {tab === 'ingestion' ? <IngestionPanel onGuide={() => openGuide('sources')} /> : null}

          {tab === 'trace' && snapshot ? (
            <>
              <PageHead
                kicker={c.pageHead.trace.kicker}
                title={c.pageHead.trace.title}
                lede={c.pageHead.trace.lede}
                onGuide={() => openGuide('trace')}
              />
              <TracePanel
                trace={snapshot.trace}
                onOpenCase={(id) => {
                  setSelected(id);
                  setTab('queue');
                }}
                onRefresh={() => void load(true)}
              />
            </>
          ) : null}

          {tab === 'metrics' && snapshot ? (
            <>
              <PageHead
                kicker={c.pageHead.metrics.kicker}
                title={c.pageHead.metrics.title}
                lede={c.pageHead.metrics.lede}
                onGuide={() => openGuide('metrics')}
              />
              <MetricsPanel metrics={snapshot.metrics} />
            </>
          ) : null}

          {tab === 'health' && snapshot ? (
            <>
              <PageHead
                kicker={c.pageHead.health.kicker}
                title={c.pageHead.health.title}
                lede={c.pageHead.health.lede}
                onGuide={() => openGuide('health')}
              />
              <HealthPanel
                health={snapshot.health}
                onRefresh={() => void load(true)}
                onOpenCase={(id) => {
                  setSelected(id);
                  setTab('queue');
                }}
              />
            </>
          ) : null}

          {tab === 'intel' ? (
            <>
              <PageHead
                kicker={c.pageHead.intel.kicker}
                title={c.pageHead.intel.title}
                lede={c.pageHead.intel.lede}
                onGuide={() => openGuide('intel')}
              />
              {/* Its own boundary: it reaches five third-party services, and a
                  failure in there must not unmount the console around it. */}
              <SectionBoundary>
                <IntelPanel prefill={intelPrefill} />
              </SectionBoundary>
            </>
          ) : null}

          {tab === 'docs' ? <DocsPanel openSection={docsSection} /> : null}

          {/* Les règles ont leur propre source — la base — et ne lisent pas le
              snapshot : elles ne doivent donc pas être prises dans l'écran de
              chargement ni le bandeau d'erreur du pipeline. */}
          {tab === 'rules' ? (
            <SectionBoundary>
              <RulesPage />
            </SectionBoundary>
          ) : null}

          {tab === 'settings' ? (
            <SettingsPage
              onChanged={() => {
                void checkAuth();
                void load(true);
              }}
              /* Settings cannot know this: nothing tells the console a source
                 exists until it sends something. Demo cases are invented, so
                 they would tick the box on an install that has never received
                 an alert. */
              alertsSeen={snapshot?.health.mode !== 'demo' && cases.length > 0}
              codeSection={
                <SectionBoundary>
                  <Suspense fallback={<p className="soc-empty">{c.common.loading}</p>}>
                    <VulnPipeSettings />
                  </Suspense>
                </SectionBoundary>
              }
            />
          ) : null}
        </main>
      )}

      {/*
        The assistant lives OUTSIDE <main>: it follows the operator from tab to
        tab, and the page context it receives is what saves it from asking
        "which alert?" when a case is already open.

        It stays mounted, like the Code tab and for the same reason:
        unmounting it on a tab change would lose the conversation in progress —
        and the next question is usually about the screen just opened.
      */}
      <Assistant
        page={{ tab, alert_id: selected ?? undefined }}
        onOpenGuide={() => openGuide('assistant')}
      />

      <footer className="soc-footer">
        <p>{c.header.footer}</p>
        {snapshot ? (
          <p>
            {c.header.lastCheck(new Date(snapshot.health.checked_at).toLocaleTimeString())} ·{' '}
            {c.header.autoRefresh(refreshSeconds)}
          </p>
        ) : null}
      </footer>
    </div>
  );
}
