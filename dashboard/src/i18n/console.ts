/**
 * Catalogue de la console MENATER, en français et en anglais.
 *
 * ============================================================================
 * POURQUOI UN SECOND CATALOGUE PLUTÔT QU'UNE BRANCHE DE `dictionary.ts`
 *
 * `dictionary.ts` porte le vocabulaire de l'analyse de code : étapes de la
 * pipeline, verdicts, devis. Celui-ci porte celui du centre d'opérations :
 * alertes, validation humaine, shadow mode. Les deux évoluent à des rythmes
 * différents et sont relus par des yeux différents. Les fondre dans un fichier
 * de 2 500 lignes aurait rendu chaque relecture pénible sans rien simplifier.
 *
 * Ils partagent en revanche LA MÊME LANGUE COURANTE (`i18n/context.tsx`) : un
 * seul sélecteur, un seul choix mémorisé, aucun écran mi-anglais mi-français.
 *
 * ============================================================================
 * LE CATALOGUE EST TYPÉ, ET C'EST LE SEUL GARDE-FOU QUI TIENNE
 *
 * `ConsoleDictionary` décrit toutes les clés. Une clé ajoutée à FR sans son
 * équivalent EN ne compile pas. Sans ça, l'écran à moitié traduit arrive au
 * bout de trois semaines et personne ne s'en aperçoit avant une démonstration.
 * ============================================================================
 */

import type { Locale } from './dictionary.ts';
import type { CaseRepository } from '../lib/types.ts';

export interface ConsoleDictionary {
  nav: {
    alerts: string;
    code: string;
    ingestion: string;
    trace: string;
    metrics: string;
    health: string;
    intel: string;
    docs: string;
    settings: string;
    rules: string;
    sections: string;
  };

  /**
   * N5 — the Ingestion tab.
   *
   * Every sentence a person reads while choosing an architecture is here, and
   * that is the point of keeping the catalogue machinery on an English-only
   * product: a typed catalogue refuses a key added on one side only, and it is
   * what stops these strings from being written inline, three files apart, in
   * three slightly different voices.
   */
  ingestion: {
    kicker: string;
    title: string;
    lede: string;
    recommended: string;
    choose: string;
    chooseLede: string;
    neverDropped: string;
    fastLaneLabel: string;
    fastLaneHelp: string;
    pushSources: string;
    pushSourcesLede: string;
    pullSources: string;
    pullSourcesLede: string;
    sections: {
      delivery: string; deliveryHint: string;
      sources: string; sourcesHint: string;
      pipeline: string; pipelineHint: string; pipelineLede: string;
    };
    severity: Record<'critical' | 'high' | 'medium' | 'low', string>;
    lanes: {
      priority: string;
      severity: string;
      transport: string;
      latency: string;
      seconds: string;
      averageDelay: (seconds: number) => string;
    };
    hybrid: { title: string; when: string; cost: string };
    push: { title: string; transport: string; when: string; cost: string };
    pull: {
      title: string; transport: string; when: string; cost: string;
      enablePolling: string;
      noSource: string;
      interval: string; intervalHelp: (halfSeconds: number) => string;
      batch: string; batchHelp: string;
      overlap: string; overlapHelp: string;
      add: string; remove: string; empty: string;
      enabled: string;
      sourceName: string; sourceNameHelp: string;
      url: string; urlHelp: (param: string) => string;
      advanced: string; advancedHint: string;
      cursorParam: string; cursorParamHelp: string;
      itemsPath: string; itemsPathHelp: string;
      authHeader: string;
      authCredential: string; authCredentialHelp: string;
      pollNow: string; polling: string;
      never: string;
      lastOk: (received: number, age: string) => string;
      lastError: (message: string) => string;
      backingOff: (delay: string) => string;
      unusable: (count: number) => string;
      unasked: (age: string) => string;
    };
  };

  header: {
    refresh: string;
    refreshing: string;
    leave: string;
    language: string;
    lastCheck: (time: string) => string;
    autoRefresh: (seconds: number) => string;
    footer: string;
  };

  login: {
    kicker: string;
    title: string;
    password: string;
    submit: string;
    submitting: string;
    failed: string;
    unavailable: string;
    note: string;
  };

  common: {
    loading: string;
    save: string;
    saving: string;
    cancel: string;
    copy: string;
    copied: string;
    retry: string;
    retrying: string;
    unknown: string;
    close: string;
    show: string;
    hide: string;
  };

  /**
   * En-tête de chaque onglet : le même bloc partout.
   *
   * Sans lui, trois onglets sur six s'ouvraient directement sur un tableau, et
   * rien ne disait ce qu'on regardait ni ce qu'on est censé en faire.
   */
  pageHead: Record<
    'alerts' | 'code' | 'trace' | 'metrics' | 'health' | 'intel',
    { kicker: string; title: string; lede: string }
  >;

  /** Lien vers la section du Guide qui explique l'onglet en cours. */
  guideLink: string;

  /** Carte de bienvenue, montrée tant que personne ne l'a écartée. */
  firstRun: {
    kicker: string;
    title: string;
    lede: string;
    steps: Array<{ label: string; text: string; action: string }>;
    dismiss: string;
  };

  /**
   * Glossaire : les mots sur lesquels un non-spécialiste trébuche.
   *
   * Ils sont expliqués LÀ OÙ ILS APPARAISSENT, dans une bulle. Renvoyer au
   * Guide pour comprendre un mot d'une colonne fait perdre la page qu'on
   * lisait, et on ne revient pas.
   */
  glossary: Record<
    'shadow' | 'confidence' | 'disagreement' | 'fallback' | 'degraded' | 'severity' | 'greyZone'
    | 'transport',
    { term: string; text: string }
  >;
  glossaryOpen: string;

  /**
   * Le « i » entoure et les plis : ce que dit l'affordance elle-meme.
   *
   * Les libelles sont ici plutot que dans le composant parce qu'ils sont
   * lus a voix haute par un lecteur d'ecran, et parce qu'un catalogue type
   * refuse une cle ajoutee d'un seul cote.
   */
  explain: { open: string };

  errors: {
    load: string;
    nothingLoaded: string;
    nothingLoadedLede: string;
    /** Messages du client HTTP : ils ne passent par aucun composant. */
    /** Un morceau d'interface chargé à la demande n'est pas arrivé. */
    chunkTitle: string;
    chunkLede: string;
    reload: string;
    apiUnreachable: string;
    apiNotResponding: string;
    unreadable: string;
    noExplanation: (status: number) => string;
    authRequired: string;
  };

  demoBanner: {
    title: string;
    text: string;
  };

  queue: {
    kicker: string;
    title: string;
    lede: string;
    shown: (shown: number, total: number) => string;
    filters: {
      all: string;
      blocked: string;
      failed: string;
      live: string;
      shadow: string;
    };
    search: string;
    searchLabel: string;
    empty: string;
    emptyAll: string;
    /** Tri : ce qui attend un humain, ou l'ordre d'arrivee. */
    sortLabel: string;
    sortPriority: string;
    sortRecent: string;
    /** Pastille sur une alerte arrivee a l'instant. */
    fresh: string;
    freshTitle: string;
    /**
     * En-tetes de la table.
     *
     * CINQ colonnes sont affichees, mais les huit libelles restent : trois
     * d'entre eux nomment desormais une donnee A L'INTERIEUR d'une cellule
     * (la severite dans « Alerte », la confiance dans « Decision », la duree
     * sous « Recu »). Les retirer du catalogue rendrait ces trois valeurs
     * anonymes — et une valeur sans nom est une valeur qu'on interprete.
     */
    columns: {
      state: string;
      alert: string;
      severity: string;
      /** Colonne fusionnee : le verdict ET la confiance qui le qualifie. */
      decision: string;
      verdict: string;
      confidence: string;
      action: string;
      dwell: string;
      received: string;
    };
    states: Record<
      'ingested' | 'enriched' | 'decided' | 'awaiting_approval' | 'actioned' | 'closed' | 'failed',
      string
    >;
    verdicts: Record<'false_positive' | 'true_positive' | 'needs_human', string>;
    waitingOnYou: (n: number) => string;
    nothingWaiting: string;
    pending: string;
    noAction: string;
    /**
     * Catalogue FERMÉ des actions du pipeline, en clair.
     *
     * `isolate_host_temporary` s'affichait tel quel dans la colonne Action et
     * dans la fiche. Une action de sécurité qu'on ne comprend pas est une
     * action qu'on approuve sans savoir ce qu'on approuve. Toute valeur hors
     * catalogue est rendue telle quelle : inventer serait pire que ne pas
     * traduire.
     */
    actions: Record<string, string>;
    fallbackVerdict: string;
    back: string;
  };

  /**
   * J0.4 — the Alerts tab's second view: one system, everything that
   * threatens it.
   *
   * Its own section rather than more keys under `queue`, because it answers a
   * different question with the same data: the queue says what to work on
   * next, this says what an asset is carrying.
   */
  systems: {
    /** The sub-navigation of the Alerts tab. */
    viewsLabel: string;
    viewQueue: string;
    viewSystems: string;
    kicker: string;
    title: string;
    /** Behind the disc: how a system is identified, and what that never does. */
    lede: string;
    shown: (n: number) => string;
    /** Labels above each half of a system's stack, count included. */
    alertsLabel: (n: number) => string;
    flawsLabel: (n: number) => string;
    /** Said in place of an empty list, and grey: an absence is not good news. */
    noAlerts: string;
    noFlaws: string;
    /**
     * The flaw half of a machine nothing maps to any code.
     *
     * A different sentence from `noFlaws`, because it is a different fact: one
     * says nobody promoted a finding, the other says we could not have listed
     * one. A sentence must not be reachable from a state it does not
     * describe — and this one names what to do about it.
     */
    noCodeMapped: string;
    /**
     * What the flaw half actually covers.
     *
     * This screen reads the QUEUE, not scan reports — so a system with no
     * flaw listed means nobody promoted one, never that the code is clean.
     * Same rule as `clean` requiring a source that ANSWERED on the Lookup
     * tab, and it REPORTS, so it stays on screen.
     */
    scope: string;
    machines: string;
    code: string;
    /** Names the system, because the button repeats once per system. */
    analyseLabel: (system: string) => string;
    awaiting: (n: number) => string;
    failed: (n: number) => string;
    /**
     * Cases this screen could not attribute to any system.
     *
     * Counted and said out loud: an overview that silently omits part of the
     * queue is the failure that shows green, in the screen built to give an
     * overview.
     */
    unattributed: (n: number) => string;
    empty: string;
  };

  caseView: {
    id: string;
    source: string;
    destination: string;
    /** The machine the alert is about — the target an isolation would name. */
    host: string;
    /**
     * J0.3 — the code that runs on that machine, when the service inventory
     * names it. Shown only when there IS a match: an install that has not
     * filled the table in would otherwise carry "not in the inventory" on
     * every card, which is noise on the screen that must stay readable.
     */
    repository: {
      title: string;
      /**
       * Keyed off the type rather than a copy of its members, so a new origin
       * cannot be added to `CaseRepository` without a sentence to explain it
       * on the card.
       */
      matchedOn: Record<CaseRepository['matched_on'], string>;
      /** Says what the button does BEFORE it is pressed: it starts nothing. */
      analyse: string;
      analyseHint: string;
      /**
       * J0.2 — why this alert in particular is worth reading the code for.
       * Takes the technique so the sentence names what made us say it.
       */
      lead: (techniqueId: string, technique: string) => string;
      /**
       * What the analysis LOOKS FOR, said before it is launched.
       *
       * A scan that comes back with nothing is read as "the code is fine", so
       * an offer that does not name its scope buys a reassurance nobody
       * measured — the rule the scan report and the Lookup tab already apply
       * to their own verdicts, applied to the moment the scan is proposed.
       * `code-lead.test.ts` fails if the analysis gains a second detector and
       * this sentence does not move.
       */
      leadScope: string;
    };
    state: string;
    dwell: string;
    attack: string;
    attackNote: string;
    rawLog: string;
    extensions: string;
    extensionsCount: (n: number) => string;
    /**
     * Ce qu'un pli annonce sans qu'on l'ouvre.
     *
     * Un pli muet oblige a l'ouvrir pour savoir s'il valait la peine : il
     * n'economise alors rien du tout. Chacun dit donc sa taille.
     */
    foldBytes: (n: number) => string;
    foldSteps: (n: number) => string;
    foldSources: (n: number) => string;
    /** Titre du pli qui range les deux empreintes, et ce qu'il annonce. */
    hashes: string;
    foldHashes: string;
    noLog: string;
    chain: string;
    chainEmpty: string;
    repeated: string;
    enrichment: string;
    degradedTitle: string;
    degradedText: (sources: string) => string;
    noSourceData: string;
    incidents: string;
    replayRequired: string;
    decision: string;
    fieldsUsed: string;
    noFields: string;
    guardrails: string;
    rawConfidence: (value: string) => string;
    fallbackTitle: string;
    fallbackText: (source: string) => string;
    engine: string;
    attempts: string;
    tokens: string;
    proposedAction: string;
    audit: string;
    integrity: string;
    sealedTitle: (row: string) => string;
    sealedText: string;
    noAuditTitle: string;
    noAuditText: string;
    auditPending: string;
    approval: {
      title: string;
      intent: string;
      blast: string;
      rollback: string;
      why: string;
      approver: string;
      approverPlaceholder: string;
      reason: string;
      reasonPlaceholder: string;
      approve: string;
      reject: string;
      sending: string;
      declarative: (minutes: number) => string;
      rejectNeedsReason: string;
      sendFailed: string;
      approvedBy: (who: string) => string;
      rejectedBy: (who: string) => string;
      expired: string;
      noReason: string;
    };
  };

  metrics: {
    stat: {
      awaiting: string;
      alerts: string;
      failed: string;
      executed: string;
      avgDwell: string;
      shadow: string;
    };
    baselineKicker: string;
    baselineTitle: string;
    baselineReached: string;
    baselineRemaining: (n: number) => string;
    qualityKicker: string;
    qualityTitle: string;
    disagreement: string;
    disagreementHelp: string;
    falsePositive: string;
    falsePositiveHelp: string;
    fallback: string;
    fallbackHelp: string;
    degraded: string;
    degradedHelp: string;
    avgConfidence: string;
    avgConfidenceHelp: string;
    tokens: string;
    tokensHelp: string;
    splitKicker: string;
    splitTitle: string;
    byVerdict: string;
    bySeverity: string;
    dwell: string;
    noDecision: string;
    average: string;
    p95: string;
    liveShadow: string;
  };

  health: {
    diagKicker: string;
    diagTitle: string;
    run: string;
    running: string;
    diagLede: string;
    diagFailed: string;
    verdicts: Record<'operational' | 'degraded' | 'broken', string>;
    summary: (ok: number, warn: number, fail: number, skip: number, duration: string) => string;
    status: Record<'ok' | 'warn' | 'fail' | 'skip', string>;
    todo: string;
    findingsKicker: string;
    findingsTitle: string;
    sourceKicker: string;
    stateTitle: string;
    engineTitle: string;
    realData: string;
    demoData: string;
    reachable: string;
    unreachable: string;
    auditDb: string;
    auditOk: string;
    auditKo: string;
    auditNote: string;
    injectTitle: string;
    injectLede: string;
    inject: string;
    injectOk: (id: string) => string;
    injectKo: (body: string) => string;
    injectFailed: string;
    scenario: string;
    scenarioHelp: string;
    /** Suivi de l'alerte injectee, jusqu'a ce qu'elle apparaisse ou non. */
    followWaiting: (id: string) => string;
    followSeen: (id: string, step: string) => string;
    followDone: (id: string) => string;
    followLost: (id: string, seconds: number) => string;
    followOpen: string;
    workflowsTitle: string;
    workflowsEmpty: string;
    loaded: string;
    notLoaded: string;

    /* --- S1.3: replaying the audit chain's hash computation -------------- */
    chainKicker: string;
    chainTitle: string;
    /** What the check does, and the two things it cannot do. Read once. */
    chainLede: string;
    chainRun: string;
    chainRunning: string;
    /** Column help for the mismatch list, which is read rarely and closely. */
    chainBreaksTitle: string;
    /**
     * The one benign cause of a mismatch, and it EXPLAINS rather than reports:
     * rows sealed before the id-inside-the-lock fix keep their broken links,
     * and the table cannot be rewritten to repair them.
     */
    chainHistoricNote: string;
    chainFailed: string;
  };
  /** Onglet Workflow : le pipeline lui-même, et ses variables. */
  workflow: {
    noWorkflows: string;
    title: string;
    lede: string;
    sectionsLabel: string;
    graphKicker: string;
    graphLabel: (name: string) => string;
    nodeCount: (nodes: number, edges: number) => string;
    pickNode: string;
    nodeId: string;
    params: string;
    noParams: string;
    effects: Record<'pure' | 'read' | 'write', string>;
    effectHelp: Record<'pure' | 'read' | 'write', string>;
    varsKicker: string;
    varsTitle: string;
    varsLede: string;
    varsSaved: string;
    varHelp: Record<string, string>;
    shadowOff: string;
    notifyOff: string;
    notifyThreshold: (level: string) => string;
    webhookOneChannel: string;
    on: string;
    off: string;
  };

  /** Sélecteur de thème : noms propres, donc chacun a besoin de son résumé. */
  theme: {
    label: string;
    help: string;
    names: Record<'grayed' | 'punk' | 'blued' | 'attck' | 'acme' | 'dark', string>;
    hints: Record<'grayed' | 'punk' | 'blued' | 'attck' | 'acme' | 'dark', string>;
  };

  /** Bandeaux d'information acquittables, par page. */
  notices: {
    readAll: string;
    markRead: string;
    markUnread: string;
    count: (n: number) => string;
    showRead: (n: number) => string;
    hideRead: string;
  };

  /** Onglet Règles : le réglage du SOC par l'équipe elle-même. */
  rules: {
    kicker: string; title: string; lede: string;
    empty: string; emptyHint: string;
    add: string; fromTemplate: string; templatesTitle: string; templatesLede: string;
    use: string; placeholderWarn: (fields: string) => string;
    name: string; owner: string; ownerHelp: string; reason: string; reasonHelp: string;
    action: string; actions: Record<'allow' | 'suppress' | 'severity' | 'escalate', string>;
    actionHelp: Record<'allow' | 'suppress' | 'severity' | 'escalate', string>;
    severity: string; priority: string; priorityHelp: string;
    expires: string; expiresHelp: string; expiresNever: string;
    enabled: string; conditions: string; conditionsHelp: string;
    addCondition: string; removeCondition: string;
    field: string; operator: string; values: string; valuesHelp: string;
    operators: Record<string, string>;
    save: string; cancel: string; remove: string; confirmRemove: string;
    matches: (n: number) => string; neverMatched: string; lastMatch: (when: string) => string;
    expired: string; expiringSoon: (days: number) => string;
    disabled: string;
    /** ACTION verbs, distinct from the `disabled` status pill: a button that
     *  reads like a state leaves you guessing whether it describes or acts. */
    enable: string; disable: string;
    /**
     * The WHOLE accessible name of the two icon-only controls on a row.
     *
     * They hold a drawing and nothing else, so nothing else names them, and
     * `Icon` keeps a captionless glyph `aria-hidden` on purpose. The rule is
     * part of the name because the pair repeats once per row: « Delete » on
     * its own, twenty times over, does not say which rule is about to go.
     */
    editRule: (name: string) => string;
    removeRule: (name: string) => string;
    testTitle: string;
    /** Sur le pli du banc d'essai : contre quoi l'alerte sera confrontee. */
    testAgainst: (n: number) => string;
    testLede: string; testRun: string; testAlert: string;
    testNoMatch: string; testMatched: (name: string) => string;
    saveFailed: string; loadFailed: string;
    /**
     * A row's write that did not land, worded by WHAT STILL HOLDS.
     *
     * Three sentences rather than one, because "could not save" is reachable
     * from three different states and says nothing about the operator's
     * exposure. A rule they believe they have just switched off and that is
     * still closing alerts is the dangerous one, and it is the only one of the
     * three that can be read off the row — the pill says `Disabled`, and its
     * absence is not a message.
     *
     * The rule is named for the reason `editRule` and `removeRule` are: the
     * pair of controls repeats once per row, and the banner sits above a list.
     * The server's own reason follows the sentence; this is the frame.
     */
    notDisabled: (name: string) => string;
    notEnabled: (name: string) => string;
    notRemoved: (name: string) => string;
    reviewTitle: string; reviewLede: string;
  };

  /**
   * Onglet Lookup — la recherche manuelle d'un indicateur.
   *
   * Le vocabulaire des trois etats (`ok` / `skipped` / `unavailable`) est
   * DELIBEREMENT celui de l'enrichissement : qui a lu un ecran a lu l'autre.
   */
  intel: {
    kicker: string;
    title: string;
    lede: string;
    fieldLabel: string;
    placeholder: string;
    run: string;
    running: string;
    fresh: string;
    freshHint: string;
    kindAuto: string;
    kindForce: string;
    kinds: {
      ipv4: string; ipv6: string; domain: string; url: string;
      hash: string; email: string; unknown: string;
    };
    queriedAs: (value: string) => string;
    refanged: string;
    privateNote: string;
    verdicts: { flagged: string; watch: string; clean: string; unknown: string };
    answered: (n: number, total: number) => string;
    took: (ms: number) => string;
    statuses: { ok: string; skipped: string; unavailable: string };
    cached: string;
    open: string;
    signalsTitle: string;
    detailsTitle: string;
    copy: string;
    copied: string;
    emptyTitle: string;
    emptyLede: string;
    examplesTitle: string;
    examples: Array<{ value: string; what: string }>;
    historyTitle: string;
    historyLede: string;
    again: string;
    providersTitle: string;
    providersLede: string;
    /**
     * Sur le pli des sources : combien repondront reellement.
     *
     * C'est le fait le plus utile de cet ecran quand aucune cle n'est posee —
     * il dit d'avance que tous les resultats seront « pas demande ».
     */
    providersReady: (ready: number, total: number) => string;
    ready: string;
    noKey: string;
    getKey: string;
    freeSource: string;
    covers: string;
    keptFor: (hours: number) => string;
    goSettings: string;
    password: {
      kicker: string;
      title: string;
      lede: string;
      neverLeaves: string;
      placeholder: string;
      check: string;
      checking: string;
      show: string;
      hide: string;
      safeTitle: string;
      safeText: string;
      pwnedTitle: string;
      pwnedText: (times: number) => string;
      pwnedAdvice: string;
      failed: string;
      unsupported: string;
      empty: string;
    };
  };

  settings: {
    title: string;
    lede: string;
    /** Nom du groupe de sous-onglets, pour les lecteurs d'écran. */
    /** Point d'entrée des alertes, et son exposition par tunnel. */
    ingestion: {
      catalogueMoved: string;
      kicker: string;
      title: string;
      lede: string;
      mode: string;
      modes: Record<'off' | 'on', string>;
      modeHelp: Record<'off' | 'on', string>;
      noSecret: string;
      secret: string;
      secretHelp: string;
      endpoint: string;
      tunnelTitle: string;
      /** Sur le pli du tunnel : il n'est requis nulle part. */
      tunnelOptional: string;
      tunnelLede: string;
      tunnelToken: string;
      tunnelTokenHelp: string;
      hostname: string;
      hostnameHelp: string;
      launch: string;
    };

    /**
     * J0.3 — the service ↔ repository table.
     *
     * The strings say twice, in two places, that the matching is EXACT. That
     * is not duplication for its own sake: someone typing `10.12.4.0/24` into
     * the identifiers field and getting silence would conclude the feature is
     * broken, and the field is where they need to read it.
     */
    inventory: {
      kicker: string;
      title: string;
      lede: string;
      exactOnly: string;
      empty: string;
      count: (n: number) => string;
      add: string;
      remove: (service: string) => string;
      service: string;
      serviceHelp: string;
      identifiers: string;
      identifiersHelp: string;
      identifiersPlaceholder: string;
      repository: string;
      repositoryHelp: string;
    };

    /**
     * Setup checklist. The first thing Settings shows, because "what is still
     * missing before this works" is the question a new install actually has.
     */
    checklist: {
      title: string;
      ready: string;
      readyHint: string;
      blocked: (n: number) => string;
      goto: string;
      items: {
        secret: string; secretHint: string;
        mode: string; modeHint: string;
        model: string; modelHint: string;
        source: string; sourceHint: string;
      };
    };

    /** Pipeline credentials. Effective without restart. */
    credentials: {
      kicker: string;
      title: string;
      lede: string;
      required: string;
      optional: string;
      lockedTitle: string;
      locked: (name: string) => string;
      fromStore: string;
      missingModel: string;
      saved: string;
      saveFailed: string;
      save: string;
    };

    /** Log sources: which ones exist, and how to point one at the console. */
    sources: {
      title: string;
      lede: string;
      pick: string;
      endpoint: string;
      install: string;
      config: (file: string) => string;
      configNoFile: string;
      verify: string;
      mapping: string;
      mappingLede: string;
      /**
       * Ce qu'un pli annonce sans qu'on l'ouvre. Une procedure et une table de
       * reference sont des PIECES : on les suit une fois, sur une autre
       * machine, et elles occupaient les trois quarts d'un ecran de reglages.
       */
      lines: (n: number) => string;
      fieldCount: (n: number) => string;
      canonical: string;
      readFrom: string;
      loadFailed: string;
    };
    sectionsLabel: string;
    /** Avertissement de la barre d'enregistrement collante. */
    unsaved: string;
    effects: Record<'immediate' | 'restart' | 'manual', string>;
    savedNote: string;
    loadFailed: string;
    saveFailed: string;
    secretSet: string;
    secretEmpty: string;
    secretKeep: string;
    secretNone: string;
    testing: string;
    testFailed: string;
    auth: {
      kicker: string;
      title: string;
      lede: string;
      warnTitle: string;
      warnText: string;
      enable: string;
      password: string;
      passwordHelp: string;
    };
    database: {
      kicker: string;
      title: string;
      lede: string;
      presets: Record<'local' | 'supabase' | 'custom', { label: string; hint: string }>;
      host: string;
      port: string;
      name: string;
      user: string;
      password: string;
      ssl: string;
      /** Marker on a field the container's environment owns. */
      fromEnv: string;
      /** Named once for the block: which variables own a field, and the rule. */
      fromEnvNote: (names: string[]) => string;
      test: string;
      connectionString: string;
      applySchema: string;
    };
    pipeline: {
      kicker: string;
      title: string;
      shadowLabel: string;
      shadowHelp: string;
      slackApproval: string;
      slackEscalation: string;
      slackWarnings: string;
      slackCritical: string;
      ticketEndpoint: string;
      isolationEndpoint: string;
      isolationTtl: string;
      errorWindow: string;
      errorThreshold: string;
      errorSuppress: string;
    };
    console: {
      kicker: string;
      title: string;
      refresh: string;
      refreshHelp: string;
      /** Avertissement quand la cadence depasse deux minutes. */
      refreshSlow: (minutes: number) => string;
      window: string;
      windowHelp: string;
      forceDemo: string;
      language: string;
      languageHelp: string;
    };
    /** The in-console assistant's own section. */
  assistantSection: {
    kicker: string;
    title: string;
    lede: string;
    enable: string;
    enableHelp: string;
    provider: string;
    providerHelp: string;
    model: string;
    modelHelp: string;
    modelDefault: (model: string) => string;
    steps: string;
    stepsHelp: string;
    key: (env: string) => string;
    keyHelp: (label: string) => string;
    keyGet: string;
    keyNote: (source: string) => string;
    keyMissing: (env: string) => string;
    keyLocked: string;
    keySaved: string;
    reads: string;
    cannot: string;
    oauthNote: string;
  };

  code: {
      kicker: string;
      title: string;
      lede: string;
    };
    revert: string;
    writtenTo: (path: string) => string;
  };

  code: {
    kicker: string;
    title: string;
    lede: string;
    settingsHint: string;
    docsHint: string;
  };

  /**
   * Onglet Suivi. Il ne montre pas des cas mais des EXECUTIONS : c'est un
   * vocabulaire different, plus technique, et il est assume comme tel — cet
   * onglet s'ouvre quand quelque chose ne colle pas, pas pour trier des
   * alertes.
   */
  trace: {
    kicker: string;
    /** Nom du groupe de sous-onglets, pour les lecteurs d'écran. */
    sectionsLabel: string;
    title: string;
    lede: string;
    refreshedAt: (time: string) => string;

    /** Bandeau de tete : les trois chiffres qui decident si on lit la suite. */
    allClear: string;
    allClearLede: string;
    attention: (n: number) => string;

    windowTitle: string;
    windowSummary: (inspected: number, attached: number) => string;
    windowSpan: (oldest: string, newest: string) => string;
    windowTruncated: (limit: number) => string;
    windowEmpty: string;

    chainsKicker: string;
    chainsTitle: string;
    chainsLede: string;
    chainsEmpty: string;
    verdicts: Record<
      'complete' | 'awaiting' | 'running' | 'broken' | 'stalled' | 'failed',
      string
    >;
    verdictHelp: Record<
      'complete' | 'awaiting' | 'running' | 'broken' | 'stalled' | 'failed',
      string
    >;
    terminalReasons: Record<'schema_rejected' | 'duplicate' | 'dedup_down', string>;
    breakAt: (workflow: string) => string;
    idleFor: (duration: string) => string;
    missingSteps: (steps: string) => string;
    stepStatus: Record<'success' | 'error' | 'waiting' | 'running' | 'missing', string>;
    handoff: Record<'items' | 'empty' | 'absent' | 'n/a', string>;
    handoffEmptyWarning: string;
    openCase: string;

    orphansKicker: string;
    orphansTitle: string;
    orphansLede: string;
    orphansEmpty: string;
    orphanReasons: Record<
      'empty_input' | 'no_alert_id' | 'no_data' | 'diagnostic_probe' | 'foreign_workflow',
      string
    >;
    orphanHelp: Record<
      'empty_input' | 'no_alert_id' | 'no_data' | 'diagnostic_probe' | 'foreign_workflow',
      string
    >;
    expected: string;
    showExpected: (n: number) => string;
    hideExpected: string;

    logKicker: string;
    logTitle: string;
    logLede: string;
    logSearch: string;
    logSearchLabel: string;
    logEmpty: string;
    logShown: (shown: number, total: number) => string;
    columns: {
      execution: string;
      workflow: string;
      status: string;
      alert: string;
      handoff: string;
      started: string;
      duration: string;
    };
    outsidePipeline: string;
    unattached: string;

    replayLede: string;
    replay: string;
    replaying: string;
    replaySameId: string;
    replaySameIdHelp: string;
    replayNewIdHelp: string;
    replayNoPayload: string;
    replayFailed: string;
  };

  /** Settings → MCP: opening the console to other AI tools. */
  mcp: {
    kicker: string;
    title: string;
    lede: string;
    statusLive: string;
    statusOff: string;
    step1: string;
    enable: string;
    enableHelp: string;
    step2: string;
    tokenSet: string;
    tokenMissing: string;
    generate: string;
    regenerate: string;
    regenerateWarning: string;
    generateFailed: string;
    tokenOnce: string;
    tokenLabel: string;
    step3: string;
    placeholderNote: string;
    loopbackNote: string;
    /** Libelle du selecteur de client : on installe sur UN client. */
    pickClient: string;
    clientClaudeDesktop: string;
    claudeDesktopPath: string;
    clientClaudeCode: string;
    clientCursor: string;
    clientVsCode: string;
    step4: string;
    test: string;
    testing: string;
    testFailed: string;
    exposes: string;
    readOnly: string;
    tools: (n: number) => string;
    prompts: (n: number) => string;
    resources: (n: number) => string;
    tokenIsAccess: string;
    copy: string;
    copied: string;
  };

  /**
   * The in-console assistant.
   *
   * Its strings live here rather than in the component for the reason the
   * catalogue exists at all — but two of them earn their place for a second
   * reason: `cannotAct` and `readOnlyNote` are the product's safety promise
   * written down where a reviewer sees it, not buried in a JSX branch.
   */
  assistant: {
    launcher: string;
    title: string;
    subtitle: string;
    placeholder: string;
    send: string;
    close: string;
    clear: string;
    thinking: string;
    suggestionsTitle: string;
    readOnlyNote: string;
    cannotAct: string;
    howItWorks: string;
    lookedUp: (names: string) => string;
    cappedSteps: string;
    cappedTools: string;
    cappedDeadline: string;
    notReady: string;
    failed: string;
    emptyLede: string;
  };
}


/* ==========================================================================
 * ENGLISH
 * ========================================================================== */

const EN: ConsoleDictionary = {
  nav: {
    alerts: 'Alerts',
    code: 'Code',
    ingestion: 'Ingestion',
    trace: 'Tracking',
    metrics: 'Metrics',
    health: 'Health',
    intel: 'Lookup',
    docs: 'Guide',
    settings: 'Settings',
    rules: 'Rules',
    sections: 'Sections',
  },

  ingestion: {
    kicker: 'Ingestion',
    title: 'How alerts get in',
    lede:
      'Two transports carry alerts into this console, and they fail differently. '
      + 'This is where you choose which one carries what, where the alerts come '
      + 'from, and what runs once one arrives.',
    recommended: 'Recommended',
    choose: 'Choose an architecture',
    chooseLede:
      'The right answer depends on your install, so each option says both what it '
      + 'buys you and what it costs. Changing it takes effect on the next alert — '
      + 'nothing to restart.',
    neverDropped:
      'No alert is ever refused for arriving on the "wrong" transport. A P4 that '
      + 'reaches the webhook is accepted and triaged; the reply simply says which '
      + 'transport the policy expected, so you can re-point that source later.',
    fastLaneLabel: 'Which priorities take the webhook',
    fastLaneHelp:
      'Everything not selected is collected by polling instead. At least one '
      + 'priority must stay on the webhook — an empty list would send P1 down the '
      + 'slow lane, which is the one configuration this page exists to prevent.',
    pushSources: 'Sources that call us',
    pushSourcesLede:
      'Each source gets its own endpoint and its own normalizer. The address and '
      + 'the install snippet below are generated from the address your browser '
      + 'reached this console on, so they are correct on this machine.',
    pullSources: 'Sources we poll',
    pullSourcesLede:
      'For sources that expose an API and never call out — and for smoothing the '
      + 'load of everything that does not need to be contained in seconds. We ask '
      + 'on our own clock, from a cursor we hold.',
    sections: {
      delivery: 'Delivery',
      deliveryHint: 'push, pull, or both',
      sources: 'Sources',
      sourcesHint: 'where alerts come from',
      pipeline: 'Pipeline',
      pipelineHint: 'what runs on arrival',
      pipelineLede:
        'What happens to an alert once it is in: the six workflows as the engine '
        + 'actually runs them, and the thresholds you can change without a restart.',
    },
    severity: {
      critical: 'Critical',
      high: 'High',
      medium: 'Medium',
      low: 'Low',
    },
    lanes: {
      priority: 'Priority',
      severity: 'Severity',
      transport: 'Transport',
      latency: 'Delay before triage',
      seconds: 'Seconds — one network hop',
      averageDelay: (seconds) => `About ${seconds} s on average — half a polling interval`,
    },
    hybrid: {
      title: 'Hybrid',
      when:
        'The webhook for P1/P2, polling for P3/P4. Critical alerts are contained in '
        + 'seconds; everything else is read in batches you size.',
      cost:
        'Two transports to keep working. Worth it because a four-minute delay '
        + 'means something entirely different to a P1 than to a P4.',
    },
    push: {
      title: 'Push only',
      // THE ARCHITECTURE AND THE TRANSPORT ARE NOT THE SAME NOUN. The card
      // names a choice ("Push only"); the lane table names the pipe an alert
      // travels down. Using one string for both put "Pull only" in a row of a
      // table describing a HYBRID policy, which reads as a contradiction.
      transport: 'Webhook',
      when:
        'Every source calls us the moment it detects something. The lowest possible '
        + 'delay, and the simplest thing to set up.',
      cost:
        'You are as reliable as your sources\u2019 retry policy: a webhook nobody '
        + 'received is a webhook nobody knows about. And a burst arrives all at once.',
    },
    pull: {
      title: 'Pull only',
      transport: 'Polling',
      when:
        'We ask each source on our own clock. Nothing is lost to a missed call, the '
        + 'load is bounded, and no source needs to reach this console.',
      cost:
        'Half a polling interval of delay on every alert, including the one that '
        + 'should have been contained in seconds.',
      enablePolling: 'Poll the sources below',
      noSource:
        'Polling is on and no source is enabled: the timer would run and reach '
        + 'nothing, while reporting itself as healthy.',
      interval: 'Poll every (seconds)',
      intervalHelp: (half) =>
        `Adds about ${half} s of delay on average — half the interval, not the whole one.`,
      batch: 'Alerts per poll',
      batchHelp: 'What bounds the load. A source with more waits for the next poll.',
      overlap: 'Overlap (seconds)',
      overlapHelp:
        'How far back before the cursor each poll reaches. A source that timestamps '
        + 'at detection but indexes a second later loses that second without it; '
        + 'deduplication throws the repeats away.',
      add: 'Add a source',
      remove: 'Remove',
      empty: 'No polled source yet.',
      enabled: 'Enabled',
      sourceName: 'Source',
      sourceNameHelp: 'Must name a mapping this console knows: generic, wazuh.',
      url: 'Address to poll',
      urlHelp: (param) => `We append ?${param}=<cursor> to it. http:// or https:// only.`,
      advanced: 'Response shape and credential',
      advancedHint: '4 settings, all with a working default',
      cursorParam: 'Cursor parameter',
      cursorParamHelp: 'The name this API gives its "since" parameter.',
      itemsPath: 'Path to the alerts',
      itemsPathHelp: 'Leave empty if the response body is the list itself.',
      authHeader: 'Header name',
      authCredential: 'Credential',
      authCredentialHelp:
        'The NAME of one of the credentials this console manages, never the value. '
        + 'Set the value in Settings \u2192 Credentials.',
      pollNow: 'Poll now',
      polling: 'Polling\u2026',
      never: 'never',
      lastOk: (received, age) =>
        `${received} alert${received === 1 ? '' : 's'} collected. Last answer: ${age} ago.`,
      lastError: (message) => `Last poll failed: ${message}`,
      // The wait is ANNOUNCED. A source the poller has decided to skip, with
      // nothing on screen saying so, looks exactly like a poller that stopped.
      backingOff: (delay) =>
        `Backing off after repeated failures \u2014 next automatic attempt in about ${delay}. `
        + '\u201cPoll now\u201d ignores the wait.',
      // Two things land in this counter now — an item with no alert id, and
      // one nested deeper than the pipeline can read — so the sentence names
      // the possibilities instead of asserting the one it used to be sure of.
      unusable: (count) =>
        `${count} item${count === 1 ? '' : 's'} could not be turned into an alert: `
        + 'no alert id, or nesting past what the pipeline can read. '
        + `${count === 1 ? 'It was' : 'They were'} counted, not silently skipped.`,
      // A CLIP IS A LOSS, AND IT IS SAID. The window is anchored on the last
      // answer this source gave, so an outage widens it — and past a point it
      // is capped, because asking a busy source for a week in one request is
      // how a response is refused for its size and the source backed off for
      // ever. What the cap leaves out is gone from this console, so the row
      // names it rather than printing the same green check as a poll that
      // covered everything.
      unasked: (age) =>
        `This source had not answered for about ${age} \u2014 longer than one poll re-reads. `
        + 'Anything it raised before that window was never requested, and will not be: '
        + 'it is still at the source, it was simply not collected here.',
    },
  },

  header: {
    refresh: 'Refresh',
    refreshing: '…',
    leave: 'Sign out',
    language: 'Language',
    lastCheck: (time) => `Last check: ${time}`,
    autoRefresh: (s) => `refreshing automatically every ${s} s`,
    footer:
      'MENATER watches two things: the security alerts that already arrived, and the flaws still sitting in your code. Nothing irreversible starts from this screen — the console shows and relays, the pipelines act.',
  },

  login: {
    kicker: 'Restricted access',
    title: 'Sign in',
    password: 'Password',
    submit: 'Enter',
    submitting: 'Checking…',
    failed: 'Wrong password.',
    unavailable: 'Cannot sign in.',
    note: 'This password protects access. It identifies nobody: the name of whoever approves an action is typed at approval time.',
  },

  common: {
    loading: 'Loading…',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    copy: 'Copy',
    copied: 'Copied',
    retry: 'Try again',
    retrying: 'Trying again…',
    unknown: 'unknown',
    close: 'Close',
    show: 'Show',
    hide: 'Hide',
  },

  pageHead: {
    alerts: {
      kicker: 'What already happened',
      title: 'Alerts',
      lede: 'Alerts raised by your appliances, triaged by an AI. You only approve what is not harmless.',
    },
    code: {
      kicker: 'What is about to happen',
      title: 'Code analysis',
      lede: 'We read your code before it ships and show you, in plain language, the flaws it holds.',
    },
    trace: {
      kicker: 'Where did my alert go?',
      title: 'Run tracking',
      lede:
        'The alert list shows CASES. This tab shows the RUNS behind them, including the ones that produced no case at all — this is where you find what went missing.',
    },
    metrics: {
      kicker: 'Can it be trusted?',
      title: 'Metrics',
      lede: 'Two numbers decide whether the AI may act on its own. They do not say the same thing, and we never mix them up.',
    },
    health: {
      kicker: 'Is everything working?',
      title: 'Health',
      lede: 'An end-to-end test of the pipeline, with the fix to apply when something is off.',
    },
    intel: {
      kicker: 'What is this thing?',
      title: 'Lookup',
      lede:
        'Ask every threat-intelligence source you hold a key for about one address, domain, '
        + 'URL, file hash or email address — and check a password against the breach corpora '
        + 'without it ever leaving your browser.',
    },
  },

  guideLink: 'How does it work?',

  firstRun: {
    kicker: 'Welcome',
    title: 'Three things to know',
    lede: 'This screen watches two very different things. Here is where to go, depending on what you are after.',
    steps: [
      {
        label: 'What is waiting on you',
        text: 'Alerts that need your approval move to the top of the list. The AI handles the rest on its own.',
        action: 'See the alerts',
      },
      {
        label: 'Check your code',
        text: 'Point at a folder or a repository: we look for known flaws and explain what we find.',
        action: 'Analyse code',
      },
      {
        label: 'Understand the tool',
        text: 'Every feature is explained without jargon, including what the application does not do.',
        action: 'Open the guide',
      },
    ],
    dismiss: 'Got it',
  },

  glossary: {
    transport: {
      term: 'transport',
      text:
        'How an alert physically reaches this console. Push: the source calls our '
        + 'webhook the instant it detects something \u2014 fastest, and only as '
        + 'reliable as the source\u2019s own retries. Pull: we ask the source on our '
        + 'own clock, from a cursor we hold \u2014 slower, and nothing is lost to a '
        + 'call that never arrived.',
    },
    shadow: {
      term: 'Watch-only mode',
      text: 'The AI decides and logs, but runs nothing. It is the default: you check whether it is right before letting it act.',
    },
    confidence: {
      term: 'Confidence',
      text: 'How sure the AI is of its verdict, from 0 to 1. A high number is not proof: it is what the model thinks of its own answer.',
    },
    disagreement: {
      term: 'Human disagreement',
      text: 'The share of decisions put to a human that the human declined. It is the only number that says whether the AI is often wrong.',
    },
    fallback: {
      term: 'Fallback verdict',
      text: 'The AI produced nothing (outage, timeout). The pipeline then forces “human decision” rather than inventing a verdict.',
    },
    degraded: {
      term: 'Incomplete intelligence',
      text: 'At least one outside source did not answer. The decision was made on less, and its confidence is capped.',
    },
    severity: {
      term: 'Severity',
      text: 'The importance stated by the appliance that raised the alert. It comes from that appliance, not from the AI.',
    },
    greyZone: {
      term: 'Grey zone',
      text: 'Cases neither clearly clean nor clearly dangerous. They are the only ones reviewed by a more capable — and more expensive — model.',
    },
  },
  glossaryOpen: 'What does this word mean?',

  explain: { open: 'What is this? Read the explanation' },

  errors: {
    load: 'Could not load.',
    nothingLoaded: 'The console could not load anything',
    nothingLoadedLede:
      'The pipeline keeps running on its side: this screen reads it, it does not drive it. Fix access in Settings, then try again.',
    chunkTitle: 'This part of the screen could not load',
    chunkLede:
      'The matching piece of interface never arrived — connection dropped, or the server restarted mid-navigation. The rest of the console keeps working.',
    reload: 'Reload the page',
    apiUnreachable: 'The console server is unreachable. Is it started (`npm run dev`)?',
    apiNotResponding:
      'The console server is not answering. Start it with `npm run serve`, or `npm run dev` for everything.',
    unreadable: 'Unreadable answer from the console server.',
    noExplanation: (status) => `The console server answered ${status} with no explanation.`,
    authRequired: 'Authentication required.',
  },

  demoBanner: {
    title: 'You are looking at sample data',
    text: 'These alerts are made up: they show what the screen looks like, they do not describe your installation. As soon as the pipeline answers, real data takes their place.',
  },

  queue: {
    kicker: 'Triage queue',
    title: 'Alerts',
    lede: 'Whatever is waiting on a human decision moves to the top, whatever time it arrived.',
    shown: (shown, total) => `${shown} shown of ${total}`,
    filters: {
      all: 'All',
      blocked: 'Waiting on you',
      failed: 'Failures',
      live: 'Live mode',
      shadow: 'Watch only',
    },
    search: 'Search: id, rule, IP address…',
    searchLabel: 'Filter alerts',
    empty: 'No alert matches this filter.',
    emptyAll: 'No alerts yet. You can inject a test one from the Health tab.',
    sortLabel: 'Sort by',
    sortPriority: 'What awaits you',
    sortRecent: 'Arrival order',
    fresh: 'new',
    freshTitle: 'Arrived less than ten minutes ago.',
    columns: {
      state: 'State',
      alert: 'Alert',
      severity: 'Severity',
      decision: 'AI decision',
      verdict: 'AI verdict',
      confidence: 'Confidence',
      action: 'Action',
      dwell: 'Time taken',
      received: 'Received',
    },
    states: {
      ingested: 'Received',
      enriched: 'Enriched',
      decided: 'Decided',
      awaiting_approval: 'Waiting on you',
      actioned: 'Action run',
      closed: 'Closed',
      failed: 'Technical failure',
    },
    verdicts: {
      false_positive: 'False alarm',
      true_positive: 'Real threat',
      needs_human: 'Human decision',
    },
    waitingOnYou: (n) => `${n} alert${n > 1 ? 's are' : ' is'} waiting on your approval.`,
    nothingWaiting: 'Nothing is waiting on you: no alert needs an approval.',
    pending: 'pending',
    noAction: 'none',
    actions: {
      isolate_host_temporary: 'cut the host off the network (temporarily)',
      ticket: 'raise a ticket',
      escalate: 'escalate to an analyst',
      auto_close: 'close automatically',
    },
    fallbackVerdict: 'fallback verdict',
    back: 'Back to the list',
  },

  systems: {
    viewsLabel: 'Views of this tab',
    viewQueue: 'Triage queue',
    viewSystems: 'By system',
    kicker: 'What threatens one system',
    title: 'Systems',
    lede:
      'A system is a machine your alerts name, and — when the service inventory maps that '
      + 'machine to a repository — the code running on it. Nothing here is guessed: the '
      + 'matching is the inventory\u2019s own, exact and case-insensitive, and an alert naming '
      + 'no machine of yours is counted apart rather than filed under a likely one.',
    shown: (n) => (n === 1 ? '1 system in this window' : `${n} systems in this window`),
    alertsLabel: (n) => `Alerts · ${n}`,
    flawsLabel: (n) => `Flaws promoted from its code · ${n}`,
    noAlerts: 'No alert in this window is attributed to this code.',
    noFlaws: 'None promoted from this code.',
    noCodeMapped: 'No code mapped to this machine.',
    scope:
      'The flaws listed here are the ones somebody sent to the triage queue from a scan '
      + 'report. This screen does not read scan reports, so an empty list means none was '
      + 'promoted — never that the code is clean.',
    machines: 'Machines',
    code: 'Code',
    analyseLabel: (system) => `Analyse the code of ${system}`,
    awaiting: (n) => (n === 1 ? '1 waiting on you' : `${n} waiting on you`),
    failed: (n) => (n === 1 ? '1 failure' : `${n} failures`),
    unattributed: (n) =>
      `${n} ${n === 1 ? 'alert names' : 'alerts name'} neither one of your machines nor any `
      + 'code. They are in the triage queue, and not on this screen.',
    empty: 'No alert in this window names a machine or a piece of code.',
  },

  caseView: {
    id: 'Id',
    source: 'Source',
    destination: 'Destination',
    host: 'Host',
    repository: {
      title: 'Code running here',
      matchedOn: {
        host: 'matched on the host',
        dest_ip: 'matched on the destination address',
        source_ip: 'matched on the source address',
        // Not a match at all: this case IS a finding out of that scan. Saying
        // "matched" would invite somebody to look for the observable that did
        // it, and there is none.
        scan_target: 'the scan this case came from',
      },
      analyse: 'Analyse this code',
      analyseHint:
        'Opens the Code tab with this target already filled in. Nothing is scanned until you launch it.',
      lead: (id, technique) =>
        `This alert says the way in was the application itself (${id} — ${technique}), `
        + 'so the flaw behind it may be in this code.',
      leadScope:
        'The analysis looks for broken access control. It will not tell you whether an '
        + 'injection is possible, so nothing found here is not the same as nothing wrong.',
    },
    state: 'State',
    dwell: 'Time taken',
    attack: 'MITRE ATT&CK techniques',
    attackNote:
      'Inferred from the rule name and the raw log by pattern matching. An analyst should confirm them: this is not a certified mapping.',
    rawLog: 'Raw log',
    extensions: 'Fields specific to your source',
    extensionsCount: (n) =>
      `${n} field${n === 1 ? '' : 's'} the mapping had no column for, kept whole`,
    foldBytes: (n) => `${n} characters`,
    foldSteps: (n) => (n === 1 ? '1 step' : `${n} steps`),
    foldSources: (n) => (n === 1 ? '1 source' : `${n} sources`),
    hashes: 'Hash chain',
    foldHashes: 'two hashes',
    noLog: '(no log received)',
    chain: 'What happened, step by step',
    chainEmpty: 'No step recorded.',
    repeated: 'Identical runs folded together',
    enrichment: 'Intelligence gathered',
    degradedTitle: 'Incomplete intelligence',
    degradedText: (sources) =>
      `Unavailable source(s): ${sources}. The decision was made with less than planned, and its confidence was capped accordingly.`,
    noSourceData: 'No data returned.',
    incidents: 'Technical incidents',
    replayRequired: '— needs replay.',
    decision: 'Decision',
    fieldsUsed: 'What the model relied on',
    noFields: 'The model cited no intelligence field.',
    guardrails: 'Guardrails applied afterwards:',
    rawConfidence: (v) => ` — model’s raw confidence: ${v}.`,
    fallbackTitle: 'Fallback verdict',
    fallbackText: (source) =>
      `No analysis was produced (${source}). This case was not triaged by the model: it is waiting for a human.`,
    engine: 'Engine',
    attempts: 'Attempts',
    tokens: 'Tokens',
    proposedAction: 'Proposed action',
    audit: 'Audit log',
    integrity: 'Integrity',
    sealedTitle: (row) => `Row ${row} sealed`,
    sealedText:
      'Each row is chained to the previous one by a hash: if someone edits the log afterwards, it shows.',
    noAuditTitle: 'No audit trail',
    noAuditText:
      'The decision was made without being logged: that is a compliance incident, the case must be replayed.',
    auditPending: 'This case has not reached the audit log yet.',
    approval: {
      title: 'Approval required',
      intent: 'What the system proposes to do',
      blast: 'What it touches if you accept',
      rollback: 'How to undo it',
      why: 'Why you are being asked',
      approver: 'Your identifier *',
      approverPlaceholder: '@first.last',
      reason: 'Reason (required when you decline)',
      reasonPlaceholder: 'What drives your decision…',
      approve: 'Accept',
      reject: 'Decline',
      sending: 'Sending…',
      declarative: (minutes) =>
        `Your identifier is logged as typed, with no verification. With no answer within ${minutes} minutes, nothing runs and the alert is escalated.`,
      rejectNeedsReason: 'Declining needs a reason: it is logged along with the decision.',
      sendFailed: 'Could not send.',
      approvedBy: (who) => `Accepted by ${who}`,
      rejectedBy: (who) => `Declined by ${who}`,
      expired: 'Expired with no answer — escalated, nothing was run',
      noReason: 'No reason given.',
    },
  },

  metrics: {
    stat: {
      awaiting: 'Waiting on you',
      alerts: 'Alerts',
      failed: 'Technical failures',
      executed: 'Actions run',
      avgDwell: 'Average handling',
      shadow: 'Watch only',
    },
    baselineKicker: 'Going live',
    baselineTitle: 'Decisions observed',
    baselineReached:
      'The 50-decision threshold is reached. Going live stays a human call: base it on the disagreement rate below, not on volume alone.',
    baselineRemaining: (n) =>
      `${n} more decision(s) to observe before an error rate means anything. Until then, the pipeline watches and runs nothing.`,
    qualityKicker: 'Decision quality',
    qualityTitle: 'Metrics',
    disagreement: 'Human disagreement',
    disagreementHelp:
      'Share of the decisions put to a human that the human declined. This rate — and only this one — tells you whether the model can be trusted.',
    falsePositive: '“False alarm” verdicts',
    falsePositiveHelp:
      'How many alerts the model files this way. It describes its behaviour, not its accuracy.',
    fallback: 'Fallback verdicts',
    fallbackHelp:
      'Alerts where the model produced nothing and the pipeline forced “human decision”.',
    degraded: 'Incomplete intelligence',
    degradedHelp: 'Cases where at least one outside source was unavailable. Their confidence is capped at 0.85.',
    avgConfidence: 'Average confidence',
    avgConfidenceHelp: 'Over the cases the model actually settled.',
    tokens: 'Consumption',
    tokensHelp: 'Tokens used over the window, input and output together.',
    splitKicker: 'Breakdown',
    splitTitle: 'Verdicts and severities',
    byVerdict: 'By verdict',
    bySeverity: 'By severity',
    dwell: 'Handling time',
    noDecision: 'No decision.',
    average: 'average',
    p95: '95th percentile',
    liveShadow: 'live / watch only',
  },

  health: {
    diagKicker: 'End-to-end check',
    diagTitle: 'Connectivity test',
    run: 'Run the test',
    running: 'Checking…',
    diagLede:
      'Checks the engine\u2019s database and that the schema is applied, the model key and the other credentials, that the node names the console reads still exist in the six workflows, whether anything has run lately, then sends a deliberately invalid message to the entry point. That probe creates no alert.',
    diagFailed: 'Test failed.',
    verdicts: {
      operational: 'Everything works',
      degraded: 'Partially working',
      broken: 'At least one link is broken',
    },
    summary: (ok, warn, fail, skip, duration) =>
      `${ok} check(s) green, ${warn} to watch, ${fail} failing, ${skip} undetermined — in ${duration}.`,
    status: { ok: 'OK', warn: 'To watch', fail: 'Failing', skip: 'Undetermined' },
    todo: 'To do:',
    findingsKicker: 'Still-open findings',
    findingsTitle: 'Observed defects',
    sourceKicker: 'Data source',
    stateTitle: 'Pipeline state',
    // The card reports the engine SHIPPED INSIDE the console, and the database
    // its run journal lives in. It was labelled `n8n` — a hardcoded literal,
    // the only string on this screen outside the catalogue, and the name of a
    // product this console no longer uses. A stale name on the screen that
    // exists to say what is working is the one place it cannot be tolerated.
    engineTitle: 'Built-in engine',
    realData: 'live data',
    demoData: 'demo',
    reachable: 'Reachable',
    unreachable: 'Unreachable',
    auditDb: 'Audit database',
    auditOk: 'No anomaly observed',
    auditKo: 'Anomaly detected',
    auditNote: 'Inferred from run errors: the console opens no database connection.',
    injectTitle: 'Inject a test alert',
    injectLede:
      'Sends a realistic alert into the pipeline, as if a security appliance had just produced it. Unlike the connectivity probe, this one creates a real case in the list.',
    inject: 'Inject',
    injectOk: (id) => `Alert ${id} sent. The pipeline is handling it; the list updates in a few seconds.`,
    // THE SERVER'S SENTENCE, SHOWN AS IT IS. It already names the status and
    // the pipeline's own reason, so a frame around it repeated the status —
    // and the frame this replaces asked "Are the workflows published?", a
    // question about machinery that left with n8n: the workflows are compiled
    // into this process and there is no publish step to get wrong.
    injectKo: (body) => body,
    injectFailed: 'Injection failed.',
    scenario: 'Alert type',
    scenarioHelp:
      'Each scenario takes a DIFFERENT path: no destination, with a hash, malformed, duplicate… A single test alert only ever proved the wiring.',
    followWaiting: (id) => `${id} sent. Waiting for its first step…`,
    followSeen: (id, step) => `${id} went through ${step}. More to come.`,
    followDone: (id) => `${id} went through the full chain, all the way to the audit.`,
    followLost: (id, seconds) =>
      `${id} produced no step in ${seconds} s. It arrived nowhere: see the Tracking tab.`,
    followOpen: 'Open in the alert queue',
    chainKicker: 'Tamper evidence',
    chainTitle: 'Verify the audit chain',
    chainLede:
      'Every audit row is sealed by the database against the one before it: a SHA-256 of its '
      + 'own canonical form plus its predecessor\u2019s hash. This replays that computation row '
      + 'by row and names anything that no longer matches \u2014 which is the only way to find '
      + 'out that a decision was altered or deleted. It is read-only: the table is append-only '
      + 'by design, so a mismatch can be accounted for and never repaired. And it is bounded, '
      + 'so that it answers on a chain of any size \u2014 the result says how much of the table '
      + 'it walked.',
    chainRun: 'Verify the chain',
    chainRunning: 'Recomputing\u2026',
    chainBreaksTitle: 'Rows that no longer match',
    chainHistoricNote:
      'One cause is known and benign. Until the sealing fix, the row id was allocated OUTSIDE '
      + 'the advisory lock, so two rows written at the same instant could seal in the opposite '
      + 'order to their ids \u2014 an intact chain that is no longer in id order, which this '
      + 'verifier reads as a broken link. Measured at 22 rows in 3,195 under concurrent load. '
      + 'Rows sealed before that fix keep their broken links for ever: the table cannot be '
      + 'rewritten, which is the point of it.',
    chainFailed: 'The chain could not be verified.',
    workflowsTitle: 'Workflows in the engine',
    workflowsEmpty: 'List unavailable — the pipeline did not answer, or no workflow was found.',
    // The engine holds its six definitions compiled in: there is no publish
    // step to pass or fail, so the pill says what CAN be true of them.
    loaded: 'loaded',
    notLoaded: 'not loaded',
  },
  workflow: {
    noWorkflows:
      'The engine returned no workflow definition. Nothing to draw \u2014 and '
      + 'nothing is wrong with the alerts already in the queue, which come from '
      + 'runs this view only describes.',
    title: 'The pipeline, as it runs',
    lede:
      'This graph is the one the engine executes — not a copy. The values that change often (thresholds, channels, delays) are at the bottom of the page: they apply to the next run, with no restart.',
    sectionsLabel: 'Pipeline workflows',
    graphKicker: 'What happens, step by step',
    graphLabel: (name) => `Graph of workflow ${name}`,
    nodeCount: (nodes, edges) => `${nodes} steps, ${edges} links`,
    pickNode: 'Pick a step in the graph to see what it does.',
    nodeId: 'Identifier, never shown anywhere else:',
    params: 'What the step actually reads',
    noParams: 'No parameters: this step only passes data through.',
    effects: {
      pure: 'Computation',
      read: 'External read',
      write: 'External write',
    },
    effectHelp: {
      pure: 'Touches nothing outside. Freely replayed after a crash: recomputing costs nothing.',
      read: 'Observes the outside without changing it. Replayed after a crash: at worst one extra call.',
      write: 'Changes the outside. NEVER replayed: if the process stops mid-call, the step is marked "indeterminate" and goes to a human.',
    },
    varsKicker: 'What you can change without touching code',
    varsTitle: 'Pipeline variables',
    varsLede:
      'Read on every run. A value changed here applies to the next alert — this used to be a docker-compose file and a container restart.',
    varsSaved: 'Saved. Applies from the next alert.',
    varHelp: {
      'pipeline.shadowMode': 'On: the pipeline decides but executes nothing. This is the default, and missing configuration counts as on.',
      'approval.timeoutMinutes': 'Past this, the alert is escalated. Expiry never executes the action.',
      'isolation.ttlMinutes': 'How long the network quarantine lasts before lifting itself.',
      'shadow.exitThreshold': 'Alerts observed before considering leaving shadow mode.',
      'errors.windowMinutes': 'Counting window used to detect a general outage.',
      'errors.systemicThreshold': 'Past this, one "systemic outage" alert replaces the individual ones.',
      'errors.suppressMinutes': 'Delay before reporting the same systemic outage again.',
      'notify.transport':
        'Where notifications go. "slack-bot" uses a Slack bot token and is the '
        + 'only one that can post to a different channel per purpose. '
        + '"slack-webhook" and "discord-webhook" each use one webhook URL, which '
        + 'is far quicker to set up \u2014 paste a URL, done \u2014 but both are '
        + 'locked by the platform to the single channel the webhook was created '
        + 'for, so the four channel settings below stop applying.',
      'notify.minSeverity':
        'The lowest alert severity that reaches your chat. "off" sends nothing. '
        + 'Below the threshold no approval request is posted \u2014 and because '
        + 'nobody was asked, the alert is NOT left waiting for an answer: it is '
        + 'escalated straight away, it says why on the card, and no action is '
        + 'executed on it. It still appears in the queue here.',
      'slack.approvalChannel': 'Where approval requests are posted. Slack bot token only \u2014 a webhook ignores it.',
      'slack.escalationChannel': 'Where an alert nobody decided on ends up. Slack bot token only \u2014 a webhook ignores it.',
      'slack.warningsChannel': 'Medium-severity incidents. Slack bot token only \u2014 a webhook ignores it.',
      'slack.criticalChannel': 'Serious incidents and general outages. Slack bot token only \u2014 a webhook ignores it.',
      'endpoint.isolation': 'Service that actually performs the quarantine.',
      'endpoint.ticket': 'Ticket creation service.',
      'llm.model': 'Model asked to triage.',
    },
    shadowOff: 'Shadow mode OFF: approved actions will really be executed.',
    notifyOff:
      'Chat notifications are OFF. No approval will be requested, so nothing '
      + 'can be approved and no action will ever be executed. Alerts still '
      + 'arrive and are still triaged \u2014 you read them here.',
    notifyThreshold: (level) =>
      `Only ${level} alerts and above reach your chat. Below that, no approval is `
      + 'requested \u2014 those alerts are escalated straight away rather than left '
      + 'waiting, and no action is executed on them. They are still in the queue here.',
    webhookOneChannel:
      'A webhook is bound by Slack or Discord to the one channel it was created '
      + 'for, so the four channel settings below no longer apply \u2014 every '
      + 'message goes to that channel. Use the Slack bot token if you need them '
      + 'routed separately.',
    on: 'On',
    off: 'Off',
  },

  theme: {
    label: 'Theme',
    help: 'Kept in this browser, like the language. It only changes your screen: not the pipeline, not what other machines see.',
    names: {
      grayed: 'Grayed',
      punk: 'Punk',
      blued: 'Blued',
      attck: 'Attck',
      acme: 'Acme',
      dark: 'Dark',
    },
    hints: {
      grayed: 'Slate and acid green',
      punk: 'Military khaki, red and cream',
      blued: 'Electric blue, lime green',
      attck: 'Blazing orange, signal yellow',
      acme: 'Light — paper and press red',
      dark: 'Deep grey, application blue',
    },
  },

  notices: {
    readAll: 'Mark all as read',
    markRead: 'Mark as read',
    markUnread: 'Mark as unread',
    count: (n) => `${n} unread message${n > 1 ? 's' : ''}`,
    showRead: (n) => `${n} acknowledged — show`,
    hideRead: 'Hide acknowledged messages',
  },
  rules: {
    kicker: 'What your team considers normal',
    title: 'Rules',
    lede:
      'A rule can only CLOSE an alert as known, soften or raise its severity, or demand a human. No rule can trigger an action — the catalogue is closed, and a text field is not where a machine gets cut off the network.',
    empty: 'No rules yet.',
    emptyHint:
      'Start from a template: they are written as conjunctions — the address AND the expected activity — because an exception on a single identity is a hole shaped like an intrusion.',
    add: 'New rule',
    fromTemplate: 'Start from a template',
    templatesTitle: 'Templates',
    templatesLede:
      'They arrive DISABLED and with no owner. A starter pack that silences alerts on install has decided something on your behalf.',
    use: 'Use',
    placeholderWarn: (fields) => `Replace before enabling: ${fields}`,
    name: 'Name',
    owner: 'Owner',
    ownerHelp: 'Who answers for this rule. An exception with no owner is one nobody will dare remove.',
    reason: 'Reason',
    reasonHelp: 'In six months this is the only thing that will justify it. It is copied into the audit row.',
    action: 'Effect',
    actions: {
      allow: 'Known — close it',
      suppress: 'Suppress (temporary)',
      severity: 'Change severity',
      escalate: 'Require a human',
    },
    actionHelp: {
      allow: 'The alert is CLOSED with its reason and its audit row. Never dropped: an alert nobody can find afterwards is indistinguishable from one never received.',
      suppress: 'Like “close”, but with a mandatory end date. Prefer it whenever the reason is temporary.',
      severity: 'Raises or lowers severity. The rest of the pipeline decides as usual, under the same guardrails.',
      escalate: 'Forces the alert to a human whatever the model concludes. Strictly more cautious.',
    },
    severity: 'Target severity',
    priority: 'Priority',
    priorityHelp: 'Lower runs first. The first matching rule wins — so “which one?” always has a single-name answer.',
    expires: 'Expires on',
    expiresHelp: 'Mandatory for “suppress”. Elsewhere, a review date is what stops an exception becoming permanent by forgetting.',
    expiresNever: 'no end date',
    enabled: 'Enabled',
    conditions: 'Conditions',
    conditionsHelp:
      'ALL must hold. That is deliberate: “ignore this IP” is the exception that gets abused, because attackers use legitimate addresses and accounts.',
    addCondition: 'Add a condition',
    removeCondition: 'Remove',
    field: 'Field',
    operator: 'Operator',
    values: 'Values',
    valuesHelp: 'One per line. They are compared as OR: any one is enough.',
    operators: {
      equals: 'equals', not_equals: 'does not equal', contains: 'contains',
      starts_with: 'starts with', ends_with: 'ends with', regex: 'matches (regex)',
      cidr: 'is in range', in_list: 'is in list',
      exists: 'is present', not_exists: 'is absent',
    },
    save: 'Save rule',
    cancel: 'Cancel',
    remove: 'Delete',
    confirmRemove: 'Delete this rule? Its history is kept.',
    matches: (n) => `${n} match${n > 1 ? 'es' : ''}`,
    neverMatched: 'never triggered',
    lastMatch: (when) => `last: ${when}`,
    expired: 'Expired',
    expiringSoon: (days) => `expires in ${days}d`,
    disabled: 'Disabled',
    enable: 'Enable',
    disable: 'Disable',
    editRule: (name) => `Edit rule “${name}”`,
    removeRule: (name) => `Delete rule “${name}”`,
    testAgainst: (n) => (n === 1 ? 'against 1 active rule' : `against ${n} active rules`),
    testTitle: 'Try it on an alert',
    testLede:
      'The real question is never “is my regex valid” but “why was this alert closed”. Paste an alert: the console says which rule would answer, without touching the pipeline.',
    testRun: 'Test',
    testAlert: 'Alert (JSON)',
    testNoMatch: 'No rule matches: the alert would take its normal course.',
    testMatched: (name) => `“${name}” matches.`,
    saveFailed: 'Could not save.',
    loadFailed: 'Could not load the rules.',
    notDisabled: (name) => `“${name}” is still enabled.`,
    notEnabled: (name) => `“${name}” is still disabled.`,
    notRemoved: (name) => `“${name}” was not deleted.`,
    reviewTitle: 'Worth reviewing',
    reviewLede: 'An exception with no end date, or one that has never triggered, is debt: nobody remembers why it is there.',
  },
  intel: {
    kicker: 'One value, every source at once',
    title: 'Lookup',
    lede:
      'Paste an IP address, a domain, a URL, a file hash or an email address. '
      + 'The console asks every source it has a key for, in one pass, and tells you '
      + 'which of them answered — because "nothing found" and "nobody looked" are not the same sentence.',
    fieldLabel: 'Value to look up',
    placeholder: '8.8.8.8 · evil.com · https://… · a file hash · someone@example.com',
    run: 'Look it up',
    running: 'Asking every source…',
    fresh: 'Ask again now',
    freshHint: 'Ignores what this console already remembers and goes back out to every source.',
    kindAuto: 'Detected automatically',
    kindForce: 'Force the kind',
    kinds: {
      ipv4: 'IPv4 address',
      ipv6: 'IPv6 address',
      domain: 'Domain',
      url: 'URL',
      hash: 'File hash',
      email: 'Email address',
      unknown: 'Unrecognised',
    },
    queriedAs: (value) => `Queried as ${value}`,
    refanged: 'Defanged input restored before querying.',
    privateNote:
      'Private address (RFC 1918, loopback or link-local). The reputation sources were not '
      + 'asked: they would be answering about somebody else\'s machine.',
    verdicts: {
      flagged: 'Flagged',
      watch: 'Worth a look',
      clean: 'Nothing against it',
      unknown: 'No answer',
    },
    // `total === 1` rather than `total > 1`: a lookup with no applicable source
    // has a total of ZERO, and "0 of 0 source answered" is the one plural this
    // line can get wrong.
    answered: (n, total) => `${n} of ${total} source${total === 1 ? '' : 's'} answered`,
    took: (ms) => `${ms} ms`,
    statuses: {
      ok: 'Answered',
      skipped: 'Not asked',
      unavailable: 'Failed',
    },
    cached: 'From this console\'s memory',
    open: 'Open the full record',
    signalsTitle: 'What the sources said',
    detailsTitle: 'Everything that came back',
    copy: 'Copy as JSON',
    copied: 'Copied',
    emptyTitle: 'Nothing looked up yet',
    emptyLede:
      'This tab answers the question an alert leaves you with: is this address, this domain '
      + 'or this file actually known for anything? It writes nothing and changes nothing — '
      + 'it asks, and shows you who answered.',
    examplesTitle: 'Try one',
    examples: [
      { value: '8.8.8.8', what: 'A public resolver: what a clean address looks like' },
      { value: '1.1.1.1', what: 'Another one, with a large exposed surface' },
      { value: 'example.com', what: 'A domain, through VirusTotal' },
      { value: 'account-exists@hibp-integration-tests.com', what: 'HIBP\'s own test address: always breached' },
    ],
    historyTitle: 'This session',
    historyLede:
      'Kept in this browser tab only, and gone when you close it. Nothing about a lookup '
      + 'is written to disk or to the audit chain.',
    again: 'Look up again',
    providersTitle: 'Sources',
    providersReady: (ready, total) => `${ready} of ${total} reachable`,
    providersLede:
      'What each one adds, and whether this install can reach it. A source with no key is '
      + 'not a failure: it is a question that was never asked, and it says so on every result.',
    ready: 'Ready',
    noKey: 'No key',
    getKey: 'Get a key',
    freeSource: 'No key needed',
    covers: 'Covers',
    keptFor: (hours) => `Answers kept ${hours} h`,
    goSettings: 'Keys go in Settings → Credentials.',
    password: {
      kicker: 'Have I Been Pwned · passwords',
      title: 'Is this password in a breach corpus?',
      lede:
        'Checks a password against the 900-odd million that have appeared in breaches. '
        + 'Free, no key, no rate limit — and no account is involved: this asks about the '
        + 'password itself, not about who uses it.',
      neverLeaves:
        'THE PASSWORD DOES NOT LEAVE THIS BROWSER. It is hashed here with SHA-1; the first '
        + 'five characters of that hash are sent, several hundred candidate suffixes come '
        + 'back, and the match is made on this page. That is k-anonymity, and it is what the '
        + 'API was built for — nobody, this console included, learns what you typed.',
      placeholder: 'The password to check',
      check: 'Check it',
      checking: 'Checking…',
      show: 'Show',
      hide: 'Hide',
      safeTitle: 'Not in the corpus',
      safeText:
        'This password appears in no breach Have I Been Pwned has indexed. That says it has '
        + 'not leaked; it says nothing about whether it is strong.',
      pwnedTitle: 'Found in breached data',
      pwnedText: (times) =>
        `This password appears ${times.toLocaleString('en')} time${times > 1 ? 's' : ''} in breach corpora.`,
      pwnedAdvice:
        'Anywhere it is in use, treat it as known to attackers: it is in the word lists '
        + 'credential-stuffing runs from.',
      failed: 'The check could not be completed.',
      unsupported:
        'This browser exposes no SHA-1 in Web Crypto, so the hash cannot be computed here — '
        + 'and sending the password to the server instead is not something this page will do.',
      empty: 'Type a password first.',
    },
  },

  settings: {
    title: 'Settings',
    lede:
      'Every block says what happens when you save: applied right away, applied to the next alert, or to be copied elsewhere. Without that, you save, nothing changes, and you have no idea why.',
    ingestion: {
      catalogueMoved:
        'The list of sources, their endpoints and their install snippets live on '
        + 'the Ingestion tab, next to the transport they configure. This page holds '
        + 'what it saves: the mode, the shared secret and the tunnel.',
      kicker: 'The alert front door',
      title: 'Ingestion',
      lede:
        'The endpoint your appliances post to, and the secret that opens it. '
        + 'Closed by default: you do not open an ingestion door by accident.',
      mode: 'What the console does with an incoming alert',
      modes: { off: 'Closed', on: 'Open' },
      modeHelp: {
        off: 'The endpoint refuses everything. This is the default: you do not open an ingestion door by accident.',
        on: 'Alerts are accepted and handled by the pipeline. A shared secret is still required \u2014 without one the endpoint stays closed.',
      },
      noSecret:
        'No shared secret: the endpoint will stay CLOSED despite the mode you picked. Without authentication anyone could inject an alert — and an alert leads to an isolation request.',
      secret: 'Shared secret',
      secretHelp:
        'Expected in the X-SOC-Token header of every alert. Compared in constant time: response time does not reveal how many characters are right.',
      endpoint: 'How to send an alert',
      tunnelTitle: 'Exposure through a Cloudflare Tunnel',
      tunnelOptional: 'optional',
      tunnelLede:
        'Optional. Lets you receive alerts from outside the network. The tunnel refuses to start until the shared secret is set.',
      tunnelToken: 'Tunnel token',
      tunnelTokenHelp:
        'Given by Cloudflare when the tunnel is created. Kept as a secret: it never leaves the server, and is never passed on the command line.',
      hostname: 'Public tunnel address',
      hostnameHelp:
        'Used to build the approval links sent to Slack. Without it, those links only work from the local network.',
      launch: 'Start the tunnel',
    },
    inventory: {
      kicker: 'Assets and code',
      title: 'Service inventory',
      lede:
        'Which repository runs on which machine. An alert about a machine listed here '
        + 'carries a link to its code, so an incident and the defect behind it can be read '
        + 'side by side.',
      exactOnly:
        'Matching is exact: a hostname or an address, written as the alert carries it. '
        + 'No ranges, no wildcards, no “close enough” — a guessed repository would send '
        + 'you to read the wrong code while an incident is open.',
      empty: 'Nothing listed yet. Alerts are triaged exactly as before; they just carry no link to any code.',
      count: (n) => `${n} service${n > 1 ? 's' : ''} listed`,
      add: 'Add a service',
      remove: (service) => `Remove ${service || 'this entry'}`,
      service: 'Service',
      serviceHelp: 'What your team calls it. This is the name the incident card shows.',
      identifiers: 'Hostnames and addresses',
      identifiersHelp:
        'One per line, exactly as your alerts spell them — the agent name, the machine name, its addresses. '
        + 'A value listed twice across the table is refused: one machine, one repository.',
      identifiersPlaceholder: 'web-01\n10.12.4.31',
      repository: 'Code to analyse',
      repositoryHelp:
        'A folder on this server, a single file, or a repository URL — the same three forms the Code tab accepts.',
    },
    checklist: {
      title: 'Before the pipeline can decide',
      ready: 'Everything is in place.',
      readyHint:
        'The endpoint is open, the model is reachable, and a source can send its alerts.',
      blocked: (n) => `${n} thing${n > 1 ? 's' : ''} left to set`,
      goto: 'Set it',
      items: {
        secret: 'Shared secret',
        secretHint:
          'Without it the endpoint stays CLOSED whatever the mode: an ingestion endpoint with no authentication accepts alerts from anyone.',
        mode: 'Endpoint open',
        modeHint: 'The mode is “Closed”: the console refuses every alert.',
        model: 'Triage model key',
        modelHint:
          'Without it, EVERY alert takes the fail-safe verdict — needs_human, confidence 0, escalate. Nothing is lost, but nothing is triaged either.',
        source: 'A log source connected',
        sourceHint:
          'Pick a source below and copy its configuration onto the machine that emits the alerts.',
      },
    },
    credentials: {
      kicker: 'Pipeline keys',
      title: 'Credentials',
      lede:
        'Read by the built-in engine at call time: a key set here takes effect on the next alert, with no restart.',
      required: 'Required',
      optional: 'Optional',
      lockedTitle: 'Set by the environment',
      locked: (name) =>
        `${name} is defined in the container's environment (shell, Docker or CI). That is a deployment decision and the console will not override it. Change it where it is defined.`,
      fromStore: 'stored in the console',
      missingModel:
        'No model key: the pipeline runs, but every alert goes to a human without having been analysed.',
      saved: 'Keys saved. They are already active.',
      saveFailed: 'Could not save the keys.',
      save: 'Save keys',
    },
    sources: {
      title: 'Log sources',
      lede:
        'Each source has its own endpoint and mapping table. Normalization happens here: nothing to write on the source side.',
      pick: 'Source',
      endpoint: 'Endpoint',
      install: 'Run on the source machine',
      config: (file) => `Paste into ${file}`,
      configNoFile: 'Request to send',
      verify: 'Check it works',
      mapping: 'Field mapping',
      lines: (n) => (n === 1 ? '1 line' : `${n} lines`),
      fieldCount: (n) => (n === 1 ? '1 field' : `${n} fields`),
      mappingLede:
        'What the console reads, and from where. A field the source does not carry stays absent — it is never invented.',
      canonical: 'MENATER field',
      readFrom: 'Read from',
      loadFailed: 'Source list unavailable.',
    },
    sectionsLabel: 'Settings areas',
    unsaved: 'Unsaved changes',
    effects: {
      immediate: 'Applied immediately',
      restart: 'Applies to the next alert',
      manual: 'To copy elsewhere',
    },
    savedNote:
      'Settings saved. Blocks marked “applies to the next alert” are pipeline variables: they are read on every run, so nothing needs restarting.',
    loadFailed: 'Could not load.',
    saveFailed: 'Could not save.',
    secretSet: '— set',
    secretEmpty: '— empty',
    secretKeep: '●●●●●●●●  (leave empty to keep it)',
    secretNone: 'not set',
    testing: 'Testing…',
    testFailed: 'Test failed.',
    auth: {
      kicker: 'Console access',
      title: 'Password',
      lede:
        'With no lock, anyone reaching the address can read alerts and accept an action. With a lock, a single password guards the door.',
      warnTitle: 'This password protects access, it identifies nobody.',
      warnText:
        'The name of whoever approves is typed at approval time and logged as is. Believing otherwise would give you a fake named audit trail.',
      enable: 'Require a password on open',
      password: 'Password',
      passwordHelp:
        'Stored as a derived hash, never in clear text. 8 failed attempts lock the address for 5 minutes.',
    },
    database: {
      kicker: 'Deduplication, audit, error log',
      title: 'Database',
      lede:
        'Where the console keeps its run journal, its audit chain and its deduplication. In Docker these come from the environment, which wins over what is saved here \u2014 so this page tests reachability and hands you the connection string, it does not redirect a running stack.',
      presets: {
        local: {
          label: 'Local Postgres',
          hint: 'A database on the same machine or network as the console. Simplest for a demo.',
        },
        supabase: {
          label: 'Supabase',
          hint: 'Hosted Postgres. The host looks like db.<project>.supabase.co; the pooler listens on 6543. TLS required.',
        },
        custom: { label: 'Other', hint: 'Any other Postgres the console container can reach.' },
      },
      host: 'Host',
      port: 'Port',
      name: 'Database',
      user: 'User',
      password: 'Password',
      ssl: 'Require TLS (mandatory on Supabase)',
      fromEnv: 'from the environment',
      fromEnvNote: (names) =>
        `Read-only here: ${names.join(', ')} ${names.length > 1 ? 'come' : 'comes'} from the container's environment (shell, Docker or CI). That is a deployment decision and the console will not override it \u2014 change it where it is defined.`,
      test: 'Test reachability',
      connectionString: 'Connection string (password masked)',
      applySchema: 'Apply the schema — without it, no deduplication and no audit',
    },
    pipeline: {
      kicker: 'Read on every run',
      title: 'Pipeline behaviour',
      shadowLabel: 'Watch-only mode',
      shadowHelp:
        'Decisions are logged but nothing is executed. It is the project default: only turn it off once you have measured human disagreement over 50 alerts.',
      slackApproval: 'Approvals channel',
      slackEscalation: 'Escalation channel',
      slackWarnings: 'Warnings channel',
      slackCritical: 'Critical channel',
      ticketEndpoint: 'Ticket service address',
      isolationEndpoint: 'Isolation service address',
      isolationTtl: 'Isolation duration (min)',
      errorWindow: 'Error window (min)',
      errorThreshold: 'Systemic failure threshold',
      errorSuppress: 'Repeat suppression (min)',
    },
    console: {
      kicker: 'Reading comfort',
      title: 'Display',
      refresh: 'Refresh (s)',
      refreshHelp: 'Between 5 and 3600. Shorter = more load on the pipeline.',
      refreshSlow: (minutes) =>
        `At this cadence the screen only updates every ${minutes} min: an alert injected now will not show up before then. The Refresh button stays immediate.`,
      window: 'Runs inspected',
      windowHelp: 'One alert costs about 5 runs: 120 covers roughly 24 alerts.',
      forceDemo: 'Force sample data (for a presentation)',
      language: 'Language',
      languageHelp: 'Applies to the whole screen, alerts and code analysis alike.',
    },
    assistantSection: {
      kicker: 'Assistant',
      title: 'In-console assistant',
      lede:
        'A chat panel that answers questions about this installation. It reads; it changes '
        + 'nothing. Its key is separate from the triage key so the two budgets — and the two '
        + 'blast radii — stay apart.',
      enable: 'Assistant available in the console',
      enableHelp:
        'Turning it off removes the panel entirely. This switch is a choice, not a safeguard: '
        + 'what keeps the assistant harmless is that it has no tool that writes anything.',
      provider: 'Provider',
      providerHelp:
        'Where the assistant sends its questions. Each provider reads its own key, so switching '
        + 'here changes which key is used — nothing else about the assistant changes.',
      model: 'Model',
      modelHelp: 'Leave empty to use the provider\u2019s default. Must support tool calling.',
      modelDefault: (model: string) => `Empty: using ${model}.`,
      steps: 'Reasoning steps',
      stepsHelp:
        'How many times it may look something up before it has to answer in words. Higher '
        + 'answers harder questions and costs more; the answer says when it hit the limit.',
      key: (env: string) => `API key (${env})`,
      keyHelp: (label: string) =>
        `Written to the credential store, not to config.json. It never comes back out: the field `
        + `shows whether a key for ${label} is set, never its value. Leave it empty to keep the `
        + 'current one.',
      keyGet: 'Where to get one',
      keyNote: (source: string) =>
        source === 'provider'
          ? 'A key is set for this provider.'
          : 'No dedicated key: falling back to the triage key, which is an OpenRouter key. Set one above to separate the two budgets.',
      keyMissing: (env: string) => `No key set for this provider. Fill ${env} above.`,
      keyLocked:
        'This key comes from the environment — the shell, Docker or CI. That is a deployment '
        + 'decision, and the console will not override it: change it where it is defined.',
      keySaved: 'Key saved. It takes effect on the next question.',
      reads:
        'It can read what these screens read: the queue and any alert in it, the chain behind '
        + 'one, the window as a timeline, the tuning rules and what they would do to an alert, '
        + 'the metrics, the health report, the setup state and the glossary.',
      cannot:
        'It cannot approve, reject, isolate, close, replay, edit a rule or change a setting. '
        + 'There is no tool for any of it — deliberately, because it reads logs an attacker wrote.',
      oauthNote:
        'Signing in with a Claude, ChatGPT or Gemini subscription is not supported: those are '
        + 'consumer sign-ins, not server-side API access. Use an API key from the provider\u2019s '
        + 'own console.',
    },

    code: {
      kicker: 'Code analysis',
      title: 'Engines and preferences',
      lede:
        'These settings drive the Code tab: which AI engine reads your code, and what the launcher offers by default.',
    },
    revert: 'Discard changes',
    writtenTo: (path) =>
      `Written to ${path} with 0600 permissions. That file holds secrets: it is excluded from Git.`,
  },

  code: {
    kicker: 'Code analysis',
    title: 'Check a project',
    lede:
      'Point at a folder, a file or a repository. We read the code, look for known flaws, and explain what we find in plain language.',
    settingsHint: 'Engines and preferences: Settings tab.',
    docsHint: 'How it works: Guide tab.',
  },

  trace: {
    kicker: 'Where did my alert go?',
    sectionsLabel: 'Tracking views',
    title: 'Run tracking',
    lede:
      'The alert list stitches runs together by alert id to show cases. That stitching hides two things: a run with no readable id shows up nowhere, and a chain that stops halfway looks like a normal case, only shorter. This tab shows them.',
    refreshedAt: (time) => `Read at ${time}.`,

    allClear: 'Nothing to report',
    allClearLede:
      'No broken chain, no stalled chain, no run attached to nothing, within the observed window.',
    attention: (n) => `${n} thing(s) to look at`,

    windowTitle: 'Observed window',
    windowSummary: (inspected, attached) =>
      `${inspected} run(s) inspected, ${attached} of them attached to an alert.`,
    windowSpan: (oldest, newest) => `From ${oldest} to ${newest}.`,
    windowTruncated: (limit) =>
      `The window is full (${limit} runs): beyond it, the console does not know. Widen "Execution window" in Settings to reach further back.`,
    windowEmpty: 'No run in the window: the pipeline processed nothing, or is unreachable.',

    chainsKicker: 'One row per alert',
    chainsTitle: 'Processing chains',
    chainsLede:
      'One row per alert, and the five steps it must go through. What is missing is shown as missing — never filled in.',
    chainsEmpty: 'No chain in the observed window.',
    verdicts: {
      complete: 'Complete',
      awaiting: 'Waiting on a human',
      running: 'Running',
      broken: 'Broken',
      stalled: 'Stalled',
      failed: 'Failed',
    },
    verdictHelp: {
      complete: 'The audit step was reached, or the stop was by design.',
      awaiting: 'A deliberate pause: step 04 is waiting for human approval. This is not a blockage.',
      running: 'The chain is moving, the last step is recent.',
      broken:
        'A step finished as "success" without handing over to the next one. This is the worst case: nothing failed, and nothing happened.',
      stalled:
        'No news for over five minutes, and not waiting for an approval. We cannot show where it breaks, but it stopped moving.',
      failed: 'A step failed, or the error handler logged a severe incident.',
    },
    terminalReasons: {
      schema_rejected: 'Stop by design: the message did not match the schema and was rejected with a 400.',
      duplicate: 'Stop by design: the alert had already been seen and deduplication dropped it.',
      dedup_down: 'Stop by design: the deduplication store did not answer, the alert was refused with a 500.',
    },
    breakAt: (workflow) => `Break at ${workflow}: this step handed nothing to the next one.`,
    idleFor: (duration) => `No news for ${duration}.`,
    missingSteps: (steps) => `Steps that never ran: ${steps}.`,
    stepStatus: {
      success: 'Success',
      error: 'Failed',
      waiting: 'Waiting',
      running: 'Running',
      missing: 'Never ran',
    },
    handoff: {
      items: 'handed over',
      empty: 'ran without handing anything over',
      absent: 'did not hand over',
      'n/a': 'last step',
    },
    handoffEmptyWarning:
      'The hand-off node ran and passed no item. Check its mode: "once" starts the sub-workflow with zero data.',
    openCase: 'Open the case',

    orphansKicker: 'What exists outside the cases',
    orphansTitle: 'Attached to no alert',
    orphansLede:
      'They ran, and they appear in no case. Without this list, they simply do not exist in the console.',
    orphansEmpty: 'No unexpected orphan run.',
    orphanReasons: {
      empty_input: 'Started empty',
      no_alert_id: 'No alert id',
      no_data: 'Unreadable content',
      diagnostic_probe: 'Diagnostic probe',
      foreign_workflow: 'Workflow outside the pipeline',
    },
    orphanHelp: {
      empty_input:
        'The sub-workflow did start, with zero data, and finished as "success". This is the signature of "once" mode on an Execute Sub-workflow node.',
      no_alert_id:
        'The run carries data, but no readable alert id: it cannot be attached to a case.',
      no_data:
        'The run detail did not come back: purged, too large, or an unreadable response. We do not know what it held.',
      diagnostic_probe:
        'The connectivity test deliberately sends an invalid alert to prove the entry point answers. It creates no case: that is the point.',
      foreign_workflow:
        'This workflow is not one of the pipeline\'s six. It is listed for the record, not as an anomaly.',
    },
    expected: 'Expected',
    showExpected: (n) => `Show the ${n} expected runs`,
    hideExpected: 'Hide expected runs',

    logKicker: 'Unstitched and unfiltered',
    logTitle: 'Run log',
    logLede:
      'Every run in the window, unstitched and unfiltered. Paste an alert id into the search box to get, in one go, everything that touched it.',
    logSearch: 'Alert id, run number, workflow…',
    logSearchLabel: 'Search the log',
    logEmpty: 'No run matches.',
    logShown: (shown, total) => `${shown} of ${total}`,
    columns: {
      execution: 'Run',
      workflow: 'Workflow',
      status: 'Status',
      alert: 'Alert',
      handoff: 'Hand-off',
      started: 'Started',
      duration: 'Duration',
    },
    outsidePipeline: 'outside the pipeline',
    unattached: 'attached to no alert',

    replayLede:
      'Sends the original payload back into the entry point, exactly as the webhook received it. This repairs nothing and changes no workflow: it creates a NEW run from the same alert.',
    replay: 'Replay this alert',
    replaying: 'Replaying…',
    replaySameId: 'Reuse the original id',
    replaySameIdHelp:
      'Deduplication will most likely drop the alert: only use this to test deduplication itself.',
    replayNewIdHelp:
      'A derived id is used, otherwise deduplication would drop the replay and nothing would run.',
    replayNoPayload:
      'This alert never went through ingestion: its original payload is unknown. The console will not replay an alert reconstructed from memory.',
    replayFailed: 'Replay failed.',
  },

    mcp: {
      kicker: 'Integration',
      title: 'Open this console to other AI tools (MCP)',
      lede:
        'Lets Claude Desktop, Claude Code, Cursor or another agent READ this installation — the '
        + 'queue, the alerts, the chains, the rules, the metrics. They can change nothing: it is the '
        + 'same read-only catalogue the panel uses, and there is no tool in it that writes.',
      statusLive: 'Live',
      statusOff: 'Closed',
      step1: '1 · Turn it on',
      enable: 'Answer MCP clients on this console',
      enableHelp:
        'Off, or without a token, the endpoint answers 404 — it does not announce itself to anyone '
        + 'who cannot already use it. Both are needed before it answers anything.',
      step2: '2 · Generate a token',
      tokenSet: 'A token is set. It cannot be displayed again — generate a new one if you have lost it.',
      tokenMissing: 'No token yet. The endpoint stays closed until there is one.',
      generate: 'Generate a token',
      regenerate: 'Generate a new token',
      regenerateWarning:
        'Generating a new one immediately invalidates the old: every client configured with it stops '
        + 'working until you paste the new one.',
      generateFailed: 'The token could not be generated.',
      tokenOnce:
        'This is the only time this token is shown. Copy it now — the blocks below already contain '
        + 'it. Once you leave this screen it cannot be displayed again.',
      tokenLabel: 'Your token',
      step3: '3 · Configure your client',
      placeholderNote:
        'The blocks below say <your token> because the existing token cannot be displayed. Generate '
        + 'a new one above to get blocks you can paste as they are.',
      loopbackNote:
        'This address is loopback: it works for a client on THIS machine. For a client elsewhere, '
        + 'reach the console on its network name and copy the blocks again — they follow the address '
        + 'you are using.',
      pickClient: 'Your client',
      clientClaudeDesktop: 'Claude Desktop',
      claudeDesktopPath:
        'Paste into ~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or '
        + '%APPDATA%\\Claude\\claude_desktop_config.json (Windows), then RESTART the app — the file is '
        + 'read at startup. Claude Desktop speaks stdio, so it reaches an HTTP endpoint through the '
        + 'mcp-remote bridge; the version is pinned deliberately.',
      clientClaudeCode: 'Claude Code (one command)',
      clientCursor: 'Cursor — .cursor/mcp.json',
      clientVsCode: 'VS Code — .vscode/mcp.json',
      step4: '4 · Prove it works',
      test: 'Test the endpoint',
      testing: 'Testing…',
      testFailed: 'The test could not run.',
      exposes: 'What you are opening',
      readOnly:
        'Read-only, and the catalogue is closed: nothing here approves, rejects, isolates, closes, '
        + 'replays, edits a rule or changes a setting.',
      tools: (n: number) => `${n} tools`,
      prompts: (n: number) => `${n} prompts`,
      resources: (n: number) => `${n} resources`,
      tokenIsAccess:
        'The token is the whole access control. Anyone who can reach this console and holds it can '
        + 'read your queue, your alerts and your rules — treat it like the console password.',
      copy: 'Copy',
      copied: 'Copied',
    },

  assistant: {
    launcher: 'Ask the assistant',
    title: 'Assistant',
    subtitle: 'Reads this console. Changes nothing.',
    placeholder: 'Ask about an alert, a rule, the queue…',
    send: 'Send',
    close: 'Close',
    clear: 'New conversation',
    thinking: 'Looking it up…',
    suggestionsTitle: 'Try one of these',
    readOnlyNote:
      'It reads the queue, the alerts, their chains, the rules, the metrics, the health report '
      + 'and the setup state.',
    cannotAct:
      'It cannot approve, isolate, close or replay anything — those stay a deliberate click of yours.',
    howItWorks: 'How does it work?',
    lookedUp: (names: string) => `Looked up: ${names}`,
    cappedSteps: 'Answered at the step limit — it may have stopped short. Ask a narrower question.',
    cappedTools: 'Answered at the lookup limit — it may have stopped short.',
    cappedDeadline: 'Answered at the time limit — it may have stopped short.',
    notReady: 'The assistant is not ready yet.',
    failed: 'The assistant could not answer.',
    emptyLede: 'Ask about what is on your screen. Answers come from this installation, not from memory.',
  },
};

const CATALOGUE: Record<Locale, ConsoleDictionary> = { en: EN };

export function consoleDictionary(locale: Locale): ConsoleDictionary {
  return CATALOGUE[locale] ?? EN;
}
