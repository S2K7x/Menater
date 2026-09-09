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

/**
 * Ou une section du Guide se range.
 *
 * ============================================================================
 * POURQUOI QUINZE TITRES A PLAT NE SE PARCOURENT PLUS
 *
 * L'en-tete du composant parlait de HUIT sections. Il y en a quinze, et
 * personne n'a repense la liste en les ajoutant. Quinze titres numerotes,
 * tous de meme poids, se lisent un par un : c'est un cout de DECISION, et son
 * remede est la categorisation — exactement le raisonnement applique a la
 * barre d'onglets principale.
 *
 * Quatre groupes, et aucune section ne disparait.
 * ============================================================================
 */
export type DocGroup = 'start' | 'work' | 'check' | 'around';

/** Une section de documentation : un titre, une accroche, des points. */
export interface DocSection {
  id: string;
  group: DocGroup;
  title: string;
  lede: string;
  points: Array<{ term: string; text: string }>;
}

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
      matchedOn: Record<'host' | 'dest_ip' | 'source_ip', string>;
      /** Says what the button does BEFORE it is pressed: it starts nothing. */
      analyse: string;
      analyseHint: string;
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
    injecting: string;
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
    workflowsKicker: string;
    workflowsTitle: string;
    workflowsEmpty: string;
    published: string;
    unpublished: string;
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
    retry: (attempts: number, backoffMs: number) => string;
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
    noDatabase: string;
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
    testTitle: string;
    /** Sur le pli du banc d'essai : contre quoi l'alerte sera confrontee. */
    testAgainst: (n: number) => string;
    testLede: string; testRun: string; testAlert: string;
    testNoMatch: string; testMatched: (name: string) => string;
    saveFailed: string; loadFailed: string;
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

    replayTitle: string;
    replayLede: string;
    replay: string;
    replaying: string;
    replaySameId: string;
    replaySameIdHelp: string;
    replayNewIdHelp: string;
    replayNoPayload: string;
    replayFailed: string;
  };

  docs: {
    kicker: string;
    title: string;
    lede: string;
    /** Intitules des quatre groupes, dans l'ordre d'affichage. */
    groups: Record<DocGroup, string>;
    sections: DocSection[];
    /** La recherche dans le Guide. */
    search: string;
    searchLabel: string;
    /** « 3 des 10 points » sur une section filtree. */
    pointsShown: (shown: number, total: number) => string;
    /** Nombre de points d'une section repliee. */
    points: (n: number) => string;
    /** Entete du bloc de resultats venant du glossaire. */
    glossaryHits: string;
    noMatch: (query: string) => string;
    clear: string;
    matches: (sections: number, points: number) => string;
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
    goToSettings: string;
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
      unusable: (count) =>
        `${count} item${count === 1 ? '' : 's'} carried no alert id and could not be read. `
        + 'They were counted, not silently skipped.',
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
      },
      analyse: 'Analyse this code',
      analyseHint:
        'Opens the Code tab with this target already filled in. Nothing is scanned until you launch it.',
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
      'Checks access to the pipeline, that the six workflows exist and are published, how they chain, their credentials, then sends a deliberately invalid message to the entry point. That probe creates no alert.',
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
    injecting: 'Injecting…',
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
    workflowsKicker: 'Six workflows',
    workflowsTitle: 'Publication',
    workflowsEmpty: 'List unavailable — the pipeline did not answer, or no workflow was found.',
    published: 'published',
    unpublished: 'not published',
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
    retry: (attempts, backoffMs) => `Retries ${attempts} times, ${backoffMs} ms apart.`,
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
    noDatabase: 'Database unreachable: the rules cannot be read.',
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
        'It can read: the queue, one alert in full, the execution chain behind it, the tuning '
        + 'rules, the metrics, the health report and the setup state.',
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

    replayTitle: 'Replay',
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

  docs: {
    kicker: 'Documentation',
    groups: {
      start: 'Start here',
      work: 'Doing the work',
      check: 'Checking the system',
      around: 'Around the console',
    },
    search: 'Search the guide…',
    searchLabel: 'Search the guide',
    pointsShown: (shown, total) => `${shown} of ${total} points`,
    points: (n) => (n === 1 ? '1 point' : `${n} points`),
    glossaryHits: 'From the glossary',
    noMatch: (query) => `Nothing in the guide mentions “${query}”.`,
    clear: 'Clear the search',
    matches: (sections, points) =>
      `${points === 1 ? '1 point' : `${points} points`} in ${sections === 1 ? '1 section' : `${sections} sections`}`,
    title: 'How it works',
    lede:
      'Everything this application does, explained without jargon. Each section unfolds; start with the first one if the tool is new to you.',
    sections: [
      {
        id: 'overview',
        group: 'start',
        title: 'What the application does',
        lede:
          'MENATER watches two very different things on one screen, because they answer the same question: what threatens this system?',
        points: [
          {
            term: 'Alerts',
            text: 'What already happened. A security appliance reports something odd, an AI triages it, and a human approves any action that would not be harmless.',
          },
          {
            term: 'Code',
            text: 'What is about to happen. We read your code before it ships and show you the flaws it holds.',
          },
          {
            term: 'The rule that never moves',
            text: 'Nothing irreversible starts from this screen. The console shows, relays a human decision, and the pipeline is what acts.',
          },
          {
            term: 'Who does the work \u2014 no third party',
            text:
              'MENATER runs its own pipeline. Six workflows \u2014 receive, enrich, decide, route, audit, and an error handler \u2014 are compiled into the console itself and executed by its own engine, with its own database. There is no workflow platform to install, no external orchestrator to keep running, and no second product that has to be reachable for an alert to be triaged. What you deploy is three containers: the database, the console, and the code analysis.',
          },
          {
            term: 'What is written, and where',
            text:
              'Every decision produces a hash-chained audit row: you can verify afterwards that none was altered or removed. Alerts closed by a rule get one too — closing is not dropping.',
          },
        ],
      },
      {
        id: 'tabs',
        group: 'start',
        title: 'The ten tabs, and what each one is for',
        lede:
          'In the order the bar at the top puts them. Two of them — Alerts and Tracking — carry a '
          + 'counter when something needs you; the rest are places you go when you have a question.',
        points: [
          { term: 'Alerts', text: 'The triage queue and the incident card. What awaits a human decision rises to the top, and the counter on the tab is how many.' },
          { term: 'Code', text: 'Run a vulnerability analysis on a folder, a file or a repository, and read the report. It keeps running while you are on another tab.' },
          { term: 'Ingestion', text: 'How alerts get in \u2014 and what happens once they do. Three sections: the delivery architecture (webhook, polling, or the recommended hybrid of the two), the sources on each transport, and the pipeline as it runs: the graph of the five stages, the effect of each step, and the variables you can edit. It replaced the tab called \u201cWorkflow\u201d, which named the machinery instead of the question.' },
          { term: 'Tracking', text: 'The unreduced view. The queue shows CASES; this shows the RUNS behind them, including the ones that produced no case at all — broken chains, runs attached to nothing, replay.' },
          { term: 'Metrics', text: 'The two rates that decide whether the AI may act on its own. They do not say the same thing and are never mixed up.' },
          { term: 'Rules', text: 'Your own tuning: what is normal here, and what should stop reaching a human. A rule closes an alert; it never makes one act.' },
          { term: 'Health', text: 'The end-to-end connectivity test, and injecting a test alert through one of nine scenarios.' },
          { term: 'Lookup', text: 'Ask every threat-intelligence source you hold a key for about one IP address, domain, URL, file hash or email address — and check a password against the breach corpora without it leaving your browser. It reads; it writes nothing.' },
          { term: 'Guide', text: 'This page. Every feature explained without jargon, including what the application does not do.' },
          { term: 'Settings', text: 'Every setting, in sub-tabs: pipeline, access, database, display, credentials, log sources, MCP and the code-analysis engines. The checklist at the top names what is still missing.' },
        ],
      },
      {
        id: 'start',
        group: 'start',
        title: 'Getting started: the four things to set',
        lede:
          "A fresh install is up in three minutes and triages nothing. That is not a fault: each of these four is a choice the console refuses to make for you. The checklist at the top of Settings tracks them.",
        points: [
          {
            term: '1. A shared secret',
            text:
              "Settings → Ingestion. Without it the front door stays CLOSED whatever mode you pick. That is deliberately the opposite of the usual habit: \u201cno authentication configured\u201d reads far too often as \u201cno authentication required\u201d, and an open endpoint accepts alerts from anyone — and an alert can lead to a machine being isolated.",
          },
          {
            term: '2. Open the door',
            text:
              "There are two: \u201cOpen\u201d has the built-in engine handle every alert that arrives, and \u201cClosed\u201d, the default, refuses everything. A shared secret is required either way \u2014 an empty one keeps the door closed rather than opening it to everyone.",
          },
          {
            term: '3. The model key',
            text:
              "Settings → Credentials. The only one whose absence changes EVERY decision: without it each alert takes the fail-safe verdict — needs_human, confidence 0, escalate. Nothing is lost, but nothing is triaged either, and you get a queue that sends 100% of its traffic to a human. It takes effect on the next alert, with no restart.",
          },
          {
            term: '4. A log source',
            text:
              "Settings → Ingestion → Sources. Pick your source and copy the generated configuration onto the machine that emits the alerts. Nothing to write on your side: normalization happens here.",
          },
          {
            term: 'Optional: Slack and enrichment',
            text:
              "With no Slack token, approval requests have nowhere to be posted — the pipeline carries on and says so. With no Shodan / AbuseIPDB / VirusTotal keys, those sources are shown as \u201cunavailable\u201d rather than filled in, and the model has to name them in its reasoning.",
          },
        ],
      },
      {
        id: 'queue',
        group: 'work',
        title: 'The Alerts tab',
        lede: 'The list is sorted by what blocks somebody, not by date.',
        points: [
          {
            term: 'Waiting on you comes first',
            text: 'An alert that has been waiting on your approval for twenty minutes goes above one closed thirty seconds ago. You never hunt for what needs you.',
          },
          {
            term: 'The confidence bar',
            text: '0.83 asks to be read; a bar is compared at a glance across forty rows. The number stays written beside it.',
          },
          {
            term: 'The “watch only” tag',
            text: 'A decision made in watch-only mode triggered nothing. Confusing the two means believing the system is acting when it is only looking.',
          },
          {
            term: 'The case sheet',
            text: 'One click opens the detail: what happened step by step, the intelligence gathered, the model’s decision and the facts it cites.',
          },
        ],
      },
      {
        id: 'approval',
        group: 'work',
        title: 'Human approval',
        lede: 'When the pipeline wants to act on your system, it stops and asks you.',
        points: [
          {
            term: 'Three things before you say yes',
            text: 'What the system proposes, what it touches, and how to undo it. An “Approve” button on its own would turn approval into a formality.',
          },
          {
            term: 'Silence is never consent',
            text: 'With no answer within the shown delay, nothing runs and the alert is escalated to a human.',
          },
          {
            term: 'Declining needs a reason',
            text: 'The reason is logged with the decision: it is what lets you understand later why the model got it wrong.',
          },
          {
            term: 'Your identifier is declarative',
            text: 'It is logged as typed, with no verification. The console password guards access; it identifies nobody.',
          },
        ],
      },
      {
        id: 'rules',
        group: 'work',
        title: 'The Rules tab',
        lede:
          "This is where your team teaches the console what is normal HERE: the authorised scanner, the backup window, the deployment account. Without that tuning an honest console alerts on everything, and a console that alerts on everything stops being read.",
        points: [
          {
            term: 'What a rule can do',
            text:
              "Four effects, and nothing else. Close an alert as known. Suppress it temporarily. Change its severity. Or demand a human whatever the model concludes. A rule can NEVER trigger an action: no effect reaches the action catalogue, and a text field is not where a machine gets cut off the network.",
          },
          {
            term: 'Closed is not dropped',
            text:
              "An alert closed by a rule still gets its audit row, with the rule name, its reason and its owner. It is simply handled without costing three enrichment calls and a model call. An alert nobody can find afterwards would be indistinguishable from one never received.",
          },
          {
            term: 'Why you are asked for TWO conditions',
            text:
              "\u201cIgnore this IP\u201d is the exception that gets abused: attackers use legitimate addresses and accounts, and a permanent allow on a single identity is a hole shaped like an intrusion. So the console refuses a permanent close that hangs on one address, user or host alone. Name the expected ACTIVITY as well — the scanner may trigger the port-scan rule; it may not exfiltrate data unnoticed.",
          },
          {
            term: 'Owner, reason, end date',
            text:
              "Required, and not paperwork. An exception nobody owns and nobody can justify is debt: in six months no one remembers why the console stopped looking, so no one dares remove it. \u201cSuppress\u201d additionally requires an end date — it is temporary by definition, and one with no end is an allow that has not admitted what it is.",
          },
          {
            term: 'First matching rule wins',
            text:
              "Rules are evaluated in priority order, lowest first, and evaluation stops at the first match. That is what lets \u201cwhy was this alert closed?\u201d be answered with ONE rule name: an engine combining them all would give an answer that changes as soon as an unrelated rule is added.",
          },
          {
            term: 'Try it before you trust it',
            text:
              "The panel at the bottom takes an alert as JSON and says which rule would answer it, without sending anything into the pipeline. The real question is never \u201cis my regex valid\u201d but \u201cwhy was this alert closed\u201d — and that one gets asked afterwards.",
          },
          {
            term: 'The templates',
            text:
              "Eight starting points, all arriving DISABLED and unowned: a starter pack that begins silencing alerts on install has decided something on your behalf. They are written as conjunctions, which is exactly the habit they exist to pass on.",
          },
          {
            term: 'An expired rule says so',
            text:
              "It stops applying but stays listed, at the top, marked. An exception that switches off in silence looks exactly like a rule that never worked. The list also surfaces rules that have never triggered — often the sign of one written for a problem that no longer exists.",
          },
        ],
      },
      {
        id: 'sources',
        group: 'work',
        title: 'Connecting a log source, and how alerts reach us',
        lede:
          "Wazuh, Splunk, Elastic, your own script: each writes alerts its own way. The console translates them into one shape, and it does that work — not you, and not the source.",
        points: [
          {
            term: 'Two transports, and they fail differently',
            text:
              "PUSH: the source calls our webhook the instant it detects something \u2014 one network hop, and you are as reliable as that source\u2019s own retry policy. PULL: we ask the source on our own clock, starting from a cursor we hold \u2014 about half a polling interval of delay, and nothing is lost to a call that never arrived. Neither is better; they cost different things.",
          },
          {
            term: 'Why hybrid is the default',
            text:
              "Because the cost of a delay is not the same for every alert. A critical alert contained four minutes late was not contained; a low alert triaged four minutes late is a low alert. So P1/P2 take the webhook and P3/P4 are polled, which also smooths the load: a source that emits a thousand alerts in a burst is read in batches you size instead of opening a thousand requests at us. Change it in Ingestion \u2192 Delivery; it applies to the next alert.",
          },
          {
            term: 'Nothing is refused for taking the wrong transport',
            text:
              "A P4 that arrives on the webhook is accepted and triaged like any other. The reply says which transport the policy expected, so you can re-point that source on purpose \u2014 dropping a detection over a routing preference would be the same mistake as rejecting an alert for a missing field.",
          },
          {
            term: 'A poll that finds nothing does not move the cursor',
            text:
              "A source that is down, slow or rate-limiting us returns nothing, exactly like a source where nothing happened. Advancing the cursor on the first case skips whatever it was holding, permanently. The cursor only ever moves to a timestamp read off an alert we actually received \u2014 and each poll reaches slightly further back than the cursor, because a source that timestamps at detection and indexes a second later would otherwise lose that second. Deduplication throws the repeats away.",
          },
          {
            term: 'One endpoint per source',
            text:
              "POST /api/ingest/wazuh, /api/ingest/generic… The ROUTE decides which mapping table applies, never the payload: a sender does not get to be taken for something else.",
          },
          {
            term: 'Wazuh in particular',
            text:
              "One file to copy into /var/ossec/integrations/, one block to paste into ossec.conf, done. The script translates NOTHING: it forwards the alert exactly as Wazuh wrote it. An integrator that maps fields turns \u201cadd a source\u201d into \u201cmaintain a parser on a production security appliance\u201d, invisible from the console and never tested.",
          },
          {
            term: 'What is required, and what is not',
            text:
              "Required: an id, a rule name, a severity, a date, the raw log. Optional: source address, destination, user, host, process, file, URL. Most real detections have NO destination — rejecting the alert over that would replace it with nothing, which is the harshest possible way to fill a gap.",
          },
          {
            term: 'An absent field stays absent',
            text:
              "It is never invented, nor replaced by an empty value that would look like data. It shows as absent on screen and is declared absent to the model. Direct consequence: an isolation cannot be proposed when no host is named.",
          },
          {
            term: 'Nothing is discarded',
            text:
              "Fields specific to your tool that the mapping cannot place travel intact in \u201cextensions\u201d. They are on the case and in the audit row — this is the raw material of a decision, and the last place where losing something is acceptable.",
          },
          {
            term: 'Severity is a policy',
            text:
              "Wazuh grades 0 to 15, the console in four steps. The default: 0-3 low, 4-7 medium, 8-11 high, 12-15 critical. \u201cLevel 8 is high\u201d is a judgement, not a fact — the full mapping is shown in Settings, beside the block to copy.",
          },
        ],
      },
      {
        id: 'engine',
        group: 'work',
        title: 'The pipeline, and who runs it',
        lede:
          'Every stage an alert goes through runs inside MENATER itself. There is no workflow platform behind it and nothing external has to be reachable for an alert to be triaged.',
        points: [
          {
            term: 'Six workflows, compiled in',
            text:
              '01-Ingestion receives and deduplicates, 02-Enrichment queries the intelligence sources, 03-AI-Decision asks the model and applies the guardrails, 04-Action-Routing decides what needs a human, 05-Audit-Log seals the record. 06-Error-Handler is called from the error branch of any of them and never sits in the normal sequence. They are TypeScript definitions in the console\u2019s own process, executed by its own engine.',
          },
          {
            term: 'There is no publish step, so there is nothing to forget',
            text:
              'The workflows cannot be half-deployed, renamed in an editor, or left unpublished, because there is no editor and no deployment. That removes a whole family of failures the console used to have to detect and report on \u2014 and it is why the connectivity test now checks the things that can still go wrong: the database, the schema, the model key, and the entry point.',
          },
          {
            term: 'The console reads its own journal',
            text:
              'Every run and every step is written to the database, and the triage queue, the metrics and the Tracking tab are built from exactly that. What you see on screen is the work this installation actually did \u2014 not a report about another product\u2019s state.',
          },
          {
            term: 'A step that writes is never replayed',
            text:
              'If the process dies mid-way through a call that changed the world \u2014 a Slack approval, a ticket, an audit row \u2014 the engine does NOT retry it on restart. The step becomes “undetermined” and rises to a human. Replaying it might send the same approval twice; guessing which happened is worse than asking.',
          },
          {
            term: 'The answer you get is the pipeline\u2019s own',
            text:
              'When you post an alert, the status code comes from the workflow: 202 accepted, 400 with the fields that were missing, 200 for a duplicate already seen, 500 when the deduplication store is unreachable. The entry point does not summarise \u2014 it hands back what the pipeline decided, so a sender whose alert was refused learns it, and learns why.',
          },
          {
            term: 'Deduplication is decided by the database',
            text:
              'The same alert sent many times at the same instant produces exactly one case: the uniqueness is enforced by the index itself, not by a check-then-insert that two simultaneous senders can both pass. Measured under load \u2014 twelve simultaneous copies give one acceptance and eleven “already seen”.',
          },
          {
            term: 'What it was measured at',
            text:
              '400 alerts injected at 50 at a time were all accepted, at roughly 120 alerts per second, and every chain finished. The audit hash chain was verified afterwards across the whole table: no fork, no altered row, and nothing left running.',
          },
        ],
      },
      {
        id: 'notify',
        group: 'work',
        title: 'Chat notifications, and how loud you want them',
        lede:
          'Three ways to connect a chat channel \u2014 two for Slack, one for Discord \u2014 and one setting that decides which alerts reach it. The second one has a consequence worth knowing before you change it.',
        points: [
          {
            term: 'The quick way: a webhook, Slack or Discord',
            text:
              'Create an incoming webhook \u2014 in Slack, or in a Discord channel under Edit Channel \u2192 Integrations \u2192 Webhooks \u2014 paste the URL into Settings \u2192 Credentials, and set the transport to "slack-webhook" or "discord-webhook". No app to install, no scopes to grant. Both platforms tie the URL to the one channel you chose when creating it, so everything the pipeline sends \u2014 approvals, escalations, incidents \u2014 arrives there. Treat the URL like a password: anyone holding it can post into that channel.',
          },
          {
            term: 'The flexible way: a Slack bot token',
            text:
              'A Slack app with a bot token can post to a different channel per purpose, which is what the four channel settings are for: approvals in one place, escalations in another, technical incidents in a third. It costs an app install and a scope, and it is the only transport that can route. This is the default, and nothing changes for an installation already using it.',
          },
          {
            term: 'Choosing the level you get notified at',
            text:
              '"Lowest severity that reaches your chat" does what it says: set it to high and only high and critical alerts are announced. Set it to off and the channel goes silent entirely. The default is low, meaning you hear about everything. It applies whichever transport you picked.',
          },
          {
            term: 'What raising it actually costs',
            text:
              'Most of what the pipeline sends is an approval REQUEST \u2014 a question. Below your threshold that question is not asked, and because nobody was asked, the alert is not left waiting thirty minutes for an answer that cannot come: it is escalated straight away and no action is executed on it. So raising the threshold does not only quieten Slack, it also means nothing at that severity gets approved. That is deliberate, and it is the safe direction.',
          },
          {
            term: 'Nothing disappears from the console',
            text:
              'A suppressed alert is still received, still triaged, still audited, and still in your queue with its verdict. Slack and Discord are notification channels; this screen is the record. The card says "below your threshold: no approval asked, nothing was run", so you can tell it apart from an alert the chat platform refused to accept.',
          },
          {
            term: 'Failing and being skipped are different things',
            text:
              'If the chat platform refuses a message \u2014 a bad token, a revoked webhook, a rate limit \u2014 the case says the request could not be posted, and names which. If your threshold suppressed it, the case says so instead. "We could not ask" and "we chose not to ask" need different fixes, so they are never merged into one sentence.',
          },
        ],
      },
      {
        id: 'metrics',
        group: 'check',
        title: 'The Metrics tab',
        lede: 'Two rates, never mixed up — the most important distinction in the whole project.',
        points: [
          {
            term: 'Human disagreement',
            text: 'The share of decisions put to a human that the human declined. It is the only figure that says whether the model is right, and it is what authorises going live.',
          },
          {
            term: '“False alarm” verdicts',
            text: 'How many alerts the model files that way. It describes what it does, not whether it is right. Showing that number alone and calling it an “error rate” would be a comfortable lie.',
          },
          {
            term: 'Fallback verdicts',
            text: 'Cases where the model produced nothing and the pipeline forced “human decision”. A rising rate announces a failure, not caution.',
          },
          {
            term: 'The 50-decision threshold',
            text: 'Below it, an error rate means nothing statistically. The pipeline stays in watch-only mode.',
          },
        ],
      },
      {
        id: 'health',
        group: 'check',
        title: 'The Health tab',
        lede: 'An end-to-end test, with four possible answers instead of two.',
        points: [
          {
            term: 'Four states',
            text: 'OK: verified. To watch: it works, but coverage is reduced. Failing: broken, with the fix. Undetermined: the console cannot conclude — and it says so rather than showing a reassuring green.',
          },
          {
            term: 'The most important check',
            text: 'The console reads exact step names inside the workflows. If someone renames one, it goes blind without saying so. The test catches that and names the missing step — run it after any workflow change.',
          },
          {
            term: 'Inject a test alert',
            text: 'Nine scenarios, one per PATH rather than per story: no destination, with a hash, low severity, malformed, duplicate… Each creates a real case in the list — unlike the connectivity probe, which is rejected before it enters. The alert goes into the console\u2019s own pipeline without passing through the front door: this is an identified human testing their own installation, not an appliance on the network.',
          },
        ],
      },
      {
        id: 'intel',
        group: 'work',
        title: 'The Lookup tab',
        lede:
          'The Lookup tab answers the question an alert leaves you with. The pipeline enriches '
          + 'automatically, but only what an alert happened to carry; this is where you ask about '
          + 'anything else — a value from a mail, a ticket, a colleague\'s message.',
        points: [
          {
            term: 'One field, five kinds',
            text:
              'Paste an IPv4 or IPv6 address, a domain, a URL, a file hash (MD5, SHA-1 or SHA-256) '
              + 'or an email address. The console works out which it is and asks only the sources '
              + 'that answer about that kind. If it reads it wrong, force the kind — auto-detection '
              + 'you cannot override is a wall the first time it is wrong.',
          },
          {
            term: 'Defanged values are welcome',
            text:
              'Indicators are written down neutralised so nobody clicks them: hxxp://, 1.2.3[.]4, '
              + 'evil(.)com, user[at]corp.com. Paste them as they are. The result always shows both '
              + 'what you typed and what was actually queried.',
          },
          {
            term: 'Three states, never two',
            text:
              'Every source reports Answered, Not asked, or Failed — the same three the enrichment '
              + 'step uses. A source with no key is Not asked, and that is not a hole in what is '
              + 'known: it is a question nobody put.',
          },
          {
            term: 'Why it will not say "clean" on its own',
            text:
              'The verdict is only Nothing against it when at least one source actually answered. '
              + 'With no keys configured every source skips, and the panel says No answer rather '
              + 'than printing reassurance over a value nobody looked at.',
          },
          {
            term: 'Flagged needs more than one engine',
            text:
              'A single VirusTotal detection out of seventy is the most common false positive there '
              + 'is, so it shows as Worth a look, not Flagged. Three engines, a named threat label, '
              + 'an AbuseIPDB confidence of 75% or more, a breach that leaked passwords, or an '
              + 'infostealer capture — those flag.',
          },
          {
            term: 'Private addresses are not sent anywhere',
            text:
              'A 10.x, 192.168.x, 127.x or link-local address is not on the Internet. Asking a '
              + 'reputation service about it would get an answer about somebody else\'s machine, so '
              + 'it is skipped and the card says why.',
          },
          {
            term: 'Have I Been Pwned, for an address',
            text:
              'With a HIBP key, an email address is checked against the breach corpora, the paste '
              + 'sites and — on a subscription that includes it — the infostealer logs. A 404 from '
              + 'that API means "in no breach", which is good news, and it is reported as an answer '
              + 'rather than as an outage.',
          },
          {
            term: 'Have I Been Pwned, for a password',
            text:
              'The password panel needs no key and is free. Your password is hashed in this browser; '
              + 'only the first five characters of the hash are sent, a few hundred candidates come '
              + 'back, and the comparison happens on the page. Nobody — this console included — '
              + 'learns what you typed. That is the k-anonymity model the API was designed around.',
          },
          {
            term: 'It spends your quota, so it remembers',
            text:
              'An answer is kept in the server\'s memory for one to twelve hours depending on the '
              + 'source, and a cached card says so with its age. "Ask again now" bypasses it. '
              + 'A rate limit is obeyed rather than retried: the card names the wait.',
          },
          {
            term: 'It writes nothing',
            text:
              'No case, no rule, no audit row, nothing on disk. A lookup is a read. The session '
              + 'history lives in this browser tab and disappears with it.',
          },
        ],
      },
      {
        id: 'trace',
        group: 'check',
        title: 'The Tracking tab',
        lede:
          'It answers one question: "I sent an alert, where did it go?" It shows runs, not cases.',
        points: [
          {
            term: 'Why an alert can look lost',
            text: 'The queue stitches runs together by alert id to display cases. A run with no readable id then shows up nowhere, and a chain that stops halfway looks like a normal case, only shorter. In the run journal both of them read as a success.',
          },
          {
            term: 'Broken chain',
            text: 'A step finished as "success" without passing anything to the next one. This is the worst case: nothing failed, and nothing happened. The screen names the exact step where it stops.',
          },
          {
            term: 'Stalled chain',
            text: 'No news for over five minutes, and not waiting for an approval. A human approval in progress is never counted here: that is a deliberate pause.',
          },
          {
            term: 'Runs attached to nothing',
            text: 'They ran and appear in no case. "Started empty" is the worst: the sub-workflow did start, with zero data. The connectivity probe produces some too — those are kept apart, as expected ones.',
          },
          {
            term: 'Finding one specific alert',
            text: 'Paste its id into the log search: you get every run that touched it at once, with its workflow, its status and the reason when it failed.',
          },
          {
            term: 'Replay',
            text: 'Sends the original payload back into the entry point. It repairs nothing and changes no workflow: it creates a new run. If the console does not hold the original payload, it refuses rather than replaying a reconstructed alert.',
          },
        ],
      },
      {
        id: 'code',
        group: 'work',
        title: 'The Code tab',
        lede: 'A security review of your code, explained for someone who is not a security expert.',
        points: [
          {
            term: 'What we look for',
            text: 'The most frequent and most costly flaws: reading other people’s data by changing a number in the address, injection into a database, script injection into a page, configuration left open.',
          },
          {
            term: 'A quote before launching',
            text: 'Before spending anything, the screen states how many places will be checked, how long it takes and what it costs. Nothing starts without your go-ahead.',
          },
          {
            term: 'Two passes, to avoid overpaying',
            text: 'A fast model reads all the code first. Only the doubtful cases — 10 to 15% — are reviewed by a more capable, more expensive model.',
          },
          {
            term: 'Three confidence zones',
            text: 'Below the first threshold it is dropped. Above the second it is reported directly. In between lies the grey zone, and that is what gets reviewed.',
          },
          {
            term: 'Full or incremental',
            text: 'The first time, everything is read. After that, only what changed since the last commit is re-analysed — the cheap everyday mode.',
          },
          {
            term: 'What is never billed twice',
            text: 'Two things cost nothing, and the screen tells them apart. "Settled without the AI" means plain rules were enough to conclude. "Already known" means a previous scan answered that exact question on that exact code — change one line and the question is asked again.',
          },
          {
            term: 'That memory survives a restart',
            text: 'What has already been answered is kept on disk, so restarting the service does not make you pay for it all over again. It can never apply to code that has moved: the answer is filed under the code it was given for. Settings shows how much is stored and offers a "Forget everything" button, which costs you one scan at full price and nothing else.',
          },
          {
            term: 'Several addresses at once',
            text: 'Addresses are checked a few at a time rather than one after another, which shortens the wait without changing what is found or what it costs. The number is in Settings; raising it too far only makes a free AI engine start refusing calls.',
          },
          {
            term: 'The report',
            text: 'Every finding is explained in plain language: what can happen, and which direction to fix it. The technical detail stays available, folded away.',
          },
          {
            term: 'An alert can fill the target in for you',
            text: 'If the service inventory in Settings says which repository runs on the machine an alert is about, the incident card carries a link here with the target already filled in. It only fills the box: nothing is estimated and nothing is scanned until you launch it.',
          },
        ],
      },
      {
        id: 'settings',
        group: 'around',
        title: 'The Settings tab',
        lede: 'Every block announces what happens when you save.',
        points: [
          {
            term: 'Applied immediately',
            text: 'Pipeline connection, password, refresh rate, language, code-analysis engines.',
          },
          {
            term: 'Pipeline credentials',
            text:
              'A sub-tab of its own, and its own place on disk: the model key, the Slack token, the enrichment keys. They take effect on the next alert, with no restart. A key already set by Docker or the shell is shown read-only with the reason — that is a deployment decision, and the console will not overwrite it silently.',
          },
          {
            term: 'Log sources',
            text:
              'The Ingestion sub-tab. The endpoint, the install commands and the configuration block are GENERATED from the address you reached the console on — not retyped from a README, where you copy \u201clocalhost\u201d onto another machine and then debug it for an hour.',
          },
          {
            term: 'Service inventory',
            text:
              'Which repository runs on which machine. An alert about a machine listed there carries a link to its code, so an incident and the defect behind it can be read side by side. Matching is exact — a hostname or an address, spelled as your alerts spell it. Nothing is guessed from a resemblance or an address range: a guessed repository would send you to read the wrong code while an incident is open.',
          },
          {
            term: 'Applies to the next alert',
            text: 'Notification channels, service addresses, TTLs and thresholds are pipeline variables: the engine reads them on every run, so a change reaches the next alert with nothing to restart. That is what separates them from the console settings, which take effect the moment you save.',
          },
          {
            term: 'Secrets never come back',
            text: 'A secret field shows “set” or “empty”, never the value. Leaving it empty keeps what exists. The browser can write a key, never read it back.',
          },
        ],
      },
      {
        id: 'assistant',
        group: 'around',
        title: 'The assistant',
        lede:
          'The chat bubble in the corner. It answers questions about THIS installation, it reads '
          + 'everything the screens read, and it can change nothing at all.',
        points: [
          {
            term: 'Ask it about what you are looking at',
            text:
              'Open an alert, then ask \u201cexplain this alert simply\u201d or \u201cwhat is the actual danger '
              + 'here?\u201d. It knows which alert is on your screen, so you never paste an identifier. '
              + 'With nothing open it answers about the queue: what is waiting, why nothing is being '
              + 'triaged, what is left to configure.',
          },
          {
            term: 'It reads live data, not its memory',
            text:
              'Seven lookups, and every answer about this installation comes through one of them: the '
              + 'queue, one alert in full, the execution chain behind it, the tuning rules, the metrics, '
              + 'the health report, the setup state. Each answer says WHICH ones it used \u2014 \u201cLooked up: '
              + 'get_alert\u201d \u2014 so you can check it against the same screen.',
          },
          {
            term: 'It cannot do anything',
            text:
              'Not \u201cit asks first\u201d: there is no tool to approve, reject, isolate, close, replay, edit a '
              + 'rule or change a setting. It can tell you a case is waiting for you; it cannot answer for '
              + 'you. Every irreversible act in this product stays a deliberate click of yours.',
          },
          {
            term: 'Why it is deliberately powerless',
            text:
              'When you ask about an alert, you are asking about a log an ATTACKER composed \u2014 the URL, the '
              + 'user agent, the attempted username were all chosen by them before we stored them. Text '
              + 'like that reaches the assistant fenced and labelled as evidence, with a marker that '
              + 'changes on every question so no stored log can forge it. But the fencing is the second '
              + 'line: the first is that an instruction smuggled through a log arrives at something with '
              + 'no button to press.',
          },
          {
            term: 'If it says it did not look, believe it',
            text:
              'It is told to answer from what a lookup returned and to say when a field was not observed '
              + '\u2014 most real detections carry no destination address. \u201cThe detection did not record one\u201d '
              + 'is the correct answer; an invented address would be the same mistake the pipeline refuses '
              + 'to make. An answer that names no lookup is general knowledge, not a statement about your '
              + 'installation.',
          },
          {
            term: 'Your key, your provider',
            text:
              'Settings \u2192 In-console assistant. OpenRouter, Anthropic, OpenAI or Google, each reading its '
              + 'own key, set on that same screen. Leave the model empty to use the provider\u2019s default. '
              + 'Until a key is set the panel says which one is missing rather than failing at the first '
              + 'question, and switching it off removes the panel entirely.',
          },
          {
            term: 'What it costs, and where it stops',
            text:
              'Each question is capped: a number of lookups, a number of reasoning steps, and a time '
              + 'limit. When a cap is reached you still get an answer, and it SAYS it was capped \u2014 ask a '
              + 'narrower question rather than trusting a partial one. Nothing is stored on the server: '
              + 'closing the console ends the conversation.',
          },
        ],
      },
      {
        id: 'limits',
        group: 'around',
        title: 'What the console does not do',
        lede: 'The limits are written here rather than discovered at the wrong moment.',
        points: [
          {
            term: 'It runs no security action',
            text: 'This screen cuts nothing off the network, deletes nothing, and opens no ticket by itself. It shows, it relays a human decision, and the pipeline is what acts — under approval whenever the action is not harmless.',
          },
          {
            term: 'A rule cannot trigger an action',
            text: 'Not even one you wrote, not even an approved one. A tuning rule closes, softens, raises or demands a human. Nothing in that catalogue leads to a machine being isolated.',
          },
          {
            term: 'It does not fill in the blanks',
            text: 'Missing data is shown as missing — “no audit trail”, “fallback verdict”. A dashboard that fills gaps with defaults teaches you to trust it at the wrong moment.',
          },
          {
            term: 'The two halves do not talk yet',
            text: 'A code scan creates no alert, and an alert triggers no scan. That is the next piece of work.',
          },
        ],
      },
    ],
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
      'It reads the queue, the alerts, the chains, the rules, the metrics and the setup state.',
    cannotAct:
      'It cannot approve, isolate, close or replay anything — those stay a deliberate click of yours.',
    howItWorks: 'How does it work?',
    lookedUp: (names: string) => `Looked up: ${names}`,
    cappedSteps: 'Answered at the step limit — it may have stopped short. Ask a narrower question.',
    cappedTools: 'Answered at the lookup limit — it may have stopped short.',
    cappedDeadline: 'Answered at the time limit — it may have stopped short.',
    notReady: 'The assistant is not ready yet.',
    goToSettings: 'Open Settings → Assistant',
    failed: 'The assistant could not answer.',
    emptyLede: 'Ask about what is on your screen. Answers come from this installation, not from memory.',
  },
};

const CATALOGUE: Record<Locale, ConsoleDictionary> = { en: EN };

export function consoleDictionary(locale: Locale): ConsoleDictionary {
  return CATALOGUE[locale] ?? EN;
}
