/**
 * Catalogue de l'interface, en anglais et en français.
 *
 * Même règle que côté serveur (`src/i18n/messages.ts`) : le catalogue est
 * typé, donc une clé ajoutée sans traduction ne compile pas. C'est le seul
 * garde-fou qui tienne dans la durée contre l'écran à moitié traduit.
 *
 * L'anglais est le défaut du dictionnaire : c'est ce que voit quelqu'un qui
 * n'a jamais touché au sélecteur. La console, elle, ouvre la section en
 * français (`fallbackLocale`, voir `context.tsx`) — une section anglaise au
 * milieu d'un écran de triage francophone donne l'impression d'avoir changé
 * d'outil.
 */

import type { IconName } from '../vulnpipe/components/Icon.tsx';

// English only. The catalogue machinery stays — it is what keeps user-facing
// strings out of components — but there is one locale in it.
export const LOCALES = ['en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export type StepName =
  | 'received'
  | 'indexing'
  | 'context_server'
  | 'detection'
  | 'aggregation'
  | 'master_review'
  | 'report';

export interface StepTranslation {
  label: string;
  running: string;
  done: string;
  failed: string;
  /** Icône SVG de l'étape — un nom du jeu maison, jamais un emoji. */
  icon: IconName;
  /** À quoi sert cette étape, pour quelqu'un qui ne code pas. */
  why: string;
  /** Une analogie du quotidien, pour ancrer l'idée sans vocabulaire technique. */
  analogy: string;
}

export interface Dictionary {
  localeName: string;
  app: {
    tagline: string;
    navHome: string;
    navAnalysis: string;
    navSettings: string;
    navProducts: string;
    navResources: string;
    footerNote: string;
    languageLabel: string;
    menu: string;
  };
  launcher: {
    title: string;
    kicker: string;
    tabs: Record<'directory' | 'file' | 'github', string>;
    question: Record<'directory' | 'file' | 'github', string>;
    help: Record<'directory' | 'file' | 'github', string>;
    placeholder: Record<'directory' | 'file' | 'github', string>;
    missingTarget: string;
    scopeLegend: string;
    fullTitle: string;
    fullHelp: string;
    incrementalTitle: string;
    incrementalHelp: string;
    commitLabel: string;
    commitHelp: string;
    commitPlaceholder: string;
    submit: string;
    submitBusy: string;
    reassurance: string;
  };
  estimate: {
    title: string;
    kicker: string;
    time: string;
    cost: string;
    routes: string;
    calls: string;
    routesHint: (free: number, billed: number) => string;
    callsHint: string;
    costFree: string;
    costUnknown: string;
    costUnknownHint: string;
    costHint: string;
    lessThanCent: string;
    targetKind: Record<'directory' | 'file' | 'github', string>;
    targetLine: (files: number, routes: number) => string;
    incrementalNote: string;
    detailShow: string;
    detailHide: string;
    detailIntro: string;
    detailSampled: (size: number) => string;
    volume: (thousands: number) => string;
    confirm: string;
    confirmBusy: string;
    nothingToScan: string;
    cancel: string;
    estimating: string;
  };
  live: {
    title: string;
    finished: string;
    examining: string;
    progress: (done: number, total: number) => string;
    countersAlerts: string;
    countersGrey: string;
    countersSafe: string;
    countersCalls: string;
    countersFree: (n: number) => string;
    countersCached: (n: number) => string;
    countersSpent: string;
    countersNotReported: string;
    waiting: string;
    feedLabel: string;
    zoneSafe: string;
    zoneGrey: string;
    zoneAlert: string;
    zoneFailed: string;
  };
  timeline: {
    heading: string;
    headingDone: string;
    empty: string;
    showDetail: string;
    hideDetail: string;
    statusRunning: string;
    statusDone: string;
    statusFailed: string;
    statusSkipped: string;
    statusPending: string;
    of: (done: number, total: number) => string;
    fallback: string;
  };
  steps: Record<StepName, StepTranslation>;
  explainer: {
    title: string;
    intro: string;
    lede: string;
    now: string;
    show: string;
    hide: string;
    costTitle: string;
    costBody: string;
  };
  report: {
    heading: string;
    securityIssue: string;
    whatToDo: string;
    noticeNotArbitrated: string;
    noticeNeedsHuman: string;
    noticeSummaryOnly: string;
    showTechnical: string;
    hideTechnical: string;
    whyVerdict: string;
    referenceCategory: string;
    problemType: string;
    whereLabel: string;
    codeHeading: string;
    codeUnavailable: string;
    codeTruncated: string;
    copyFixPrompt: string;
    copyFixPromptHelp: string;
    copied: string;
    copyFailed: string;
    openInEditor: (editor: string) => string;
    openInEditorHelp: string;
    copyReport: string;
    downloadReport: string;
    exportHelp: string;
    reportCopied: string;
    /**
     * Les compteurs du verdict, la mention de ligne et l'ecran vide.
     *
     * Ils etaient ECRITS EN FRANCAIS dans le composant, dans un produit passe
     * en anglais seul — et sur l'ecran le plus lu de cet onglet. Un catalogue
     * type ne peut refuser une chaine qu'il ne connait pas : c'est justement
     * pour cela qu'elles y entrent.
     */
    countCritical: (n: number) => string;
    countWarning: (n: number) => string;
    countDismissed: (n: number) => string;
    /**
     * L'ecran « aucune faille trouvee », travaille.
     *
     * ========================================================================
     * POURQUOI CET ECRAN A BESOIN DE DIX CHAINES
     *
     * Un rapport vide ressemble a une panne. Pire : quand il ne ressemble pas
     * a une panne, il ressemble a une PREUVE — et il n'en est pas une. « Rien
     * trouve » n'est vrai que de ce qui a ete regarde, et cet ecran est le
     * seul endroit ou la difference se voit.
     *
     * Trois cas que la phrase unique confondait :
     *   - tout a ete analyse, rien trouve                → un resultat ;
     *   - des adresses n'ont PAS pu etre analysees       → un resultat partiel ;
     *   - seul ce qui a change a ete relu                → ne dit rien du reste.
     *
     * C'est la meme regle que l'onglet Lookup : « clean » exige une source qui
     * a REPONDU.
     * ========================================================================
     */
    nothing: {
      titleClear: string;
      titlePartial: string;
      /** Ni rassurant ni alarmant : on ne sait pas ce qui a ete lu. */
      titleUnknown: string;
      lede: string;
      scope: string;
      files: (n: number) => string;
      routesFound: (n: number) => string;
      routesAnalyzed: (n: number) => string;
      failed: (n: number) => string;
      modeFull: string;
      modeIncremental: string;
      caveatIncremental: string;
      caveatFailed: string;
      dismissed: (n: number) => string;
      dismissedFold: string;
      unknown: string;
    };
    analysis: string;
    lineSuffix: (line: number) => string;
  };
  status: {
    heading: string;
    labels: Record<'open' | 'fixed' | 'accepted' | 'false_positive', string>;
    noteLabel: (status: string) => string;
    notePlaceholder: string;
    noteRequired: string;
    confirm: string;
    cancel: string;
    staleWarning: string;
    summaryHeading: string;
    fixRate: (percent: number) => string;
    nothingToTreat: string;
    dismissedCount: (n: number) => string;
    excludedNote: string;
  };
  usage: {
    heading: string;
    calls: string;
    cost: string;
    compute: string;
    showDetail: string;
    hideDetail: string;
    byStage: string;
    stage: string;
    callsColumn: string;
    input: string;
    output: string;
    thinking: string;
    /**
     * Le poste le moins visible de la facture, explique plutot que laisse nu.
     * Il etait ecrit en francais dans le composant.
     */
    thinkingNote: string;
    costColumn: string;
    notReported: string;
    free: string;
    byModel: string;
    model: string;
    partial: string;
    stages: Record<string, string>;
  };
  providers: {
    heading: string;
    intro: string;
    detectionRole: string;
    detectionHelp: string;
    arbitrationRole: string;
    arbitrationHelp: string;
    model: string;
    modelPlaceholder: string;
    modelHint: string;
    effortLabel: string;
    effortHint: string;
    effortNames: Record<'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max', string>;
    unavailable: string;
    keyMissing: string;
    cannotUse: (why: string) => string;
    apply: string;
    applying: string;
    lockedDuringScan: string;
    names: Record<string, string>;
    descriptions: Record<string, string>;
  };
  landing: {
    kicker: string;
    title: string;
    titleEm: string;
    lede: string;
    ctaPrimary: string;
    ctaSecondary: string;
    stats: Array<{ value: string; label: string }>;
    problemKicker: string;
    problemTitle: string;
    problemLede: string;
    problems: Array<{ title: string; body: string }>;
    flowKicker: string;
    flowTitle: string;
    flowLede: string;
    flowCaption: string;
    diagram: {
      localLabel: string;
      cloudLabel: string;
      commit: string;
      commitNote: string;
      indexer: string;
      indexerNote: string;
      mcp: string;
      mcpNote: string;
      nodes: string;
      nodesNote: string;
      aggregator: string;
      aggregatorNote: string;
      master: string;
      masterNote: string;
      report: string;
      reportNote: string;
      free: string;
      billed: string;
      dropped: string;
    };
    stepsKicker: string;
    stepsTitle: string;
    stepsLede: string;
    zonesKicker: string;
    zonesTitle: string;
    zonesLede: string;
    zones: Array<{ range: string; title: string; body: string; tone: 'green' | 'orange' | 'red' }>;
    costKicker: string;
    costTitle: string;
    costLede: string;
    funnel: Array<{ label: string; note: string; share: number }>;
    costPoints: Array<{ title: string; body: string }>;
    coverageKicker: string;
    coverageTitle: string;
    coverageLede: string;
    coverageColumns: { name: string; what: string; status: string };
    coverage: Array<{ name: string; what: string; live: boolean }>;
    statusLive: string;
    statusPlanned: string;
    rulesKicker: string;
    rulesTitle: string;
    rules: Array<{ title: string; body: string }>;
    faqKicker: string;
    faqTitle: string;
    faq: Array<{ q: string; a: string }>;
    finalTitle: string;
    finalBody: string;
    finalCta: string;
  };
  settings: {
    heading: string;
    lede: string;
    savedLocally: string;
    savedOnServer: string;
    scanKicker: string;
    scanTitle: string;
    scanLede: string;
    defaultKindLabel: string;
    defaultKindHelp: string;
    defaultModeLabel: string;
    defaultModeHelp: string;
    rememberTargetLabel: string;
    rememberTargetHelp: string;
    rememberedTargetNone: string;
    forgetTarget: string;
    autoConfirmLabel: string;
    autoConfirmHelp: string;
    autoConfirmOff: string;
    autoConfirmOn: (amount: string) => string;
    keysEditTitle: string;
    keysEditLede: string;
    keyLabel: Record<string, string>;
    keyHelp: Record<string, string>;
    keySet: string;
    keyEmpty: string;
    keyFromEnv: string;
    keyFromDotenv: string;
    keyFromEnvHelp: string;
    keyPlaceholder: string;
    keyPlaceholderKeep: string;
    keyPlaceholderUrl: string;
    keysSave: string;
    keysSaving: string;
    keysSaved: string;
    keyClear: string;
    keyClearConfirm: (name: string) => string;
    keysNothingToSave: string;
    keysEffect: string;
    arbitrationKicker: string;
    arbitrationTitle: string;
    arbitrationLede: string;
    bypassLabel: string;
    bypassHelp: string;
    bypassWarning: string;
    concurrencyTitle: string;
    concurrencyLabel: string;
    concurrencyHelp: (min: number, max: number) => string;
    concurrencyWarning: string;
    cacheKicker: string;
    cacheTitle: string;
    cachePersisted: string;
    cacheMemoryOnly: string;
    cacheDetection: string;
    cacheArbitration: string;
    cacheHits: string;
    cacheRestoreFailed: (kind: string, why: string) => string;
    cacheForgetHelp: string;
    cacheForget: string;
    cacheForgetting: string;
    thresholdsTitle: string;
    thresholdsLede: string;
    displayKicker: string;
    displayTitle: string;
    displayLede: string;
    editorLabel: string;
    editorHelp: string;
    technicalByDefaultLabel: string;
    technicalByDefaultHelp: string;
    explanationsLabel: string;
    explanationsHelp: string;
    languageLabel: string;
    languageHelp: string;
    systemKicker: string;
    systemTitle: string;
    systemLede: string;
    serverLabel: string;
    serverOnline: string;
    serverOffline: string;
    serverChecking: string;
    recheck: string;
    keysTitle: string;
    keysLede: string;
    keyReady: string;
    keyMissing: string;
    resetTitle: string;
    resetHelp: string;
    reset: string;
    resetDone: string;
    on: string;
    off: string;
  };
  severity: Record<string, { label: string; explanation: string }>;
  glossary: Record<string, string>;
  errors: {
    unreachable: string;
    generic: string;
    /** Answered, but with something that is not the expected result. */
    unreadable: string;
    streamLost: string;
    scanInterrupted: string;
  };
  restart: string;
}

const EN: Dictionary = {
  localeName: 'English',
  app: {
    tagline: "We check your code for security holes and explain what we find, without the jargon.",
    navHome: 'Overview',
    navAnalysis: 'Analysis',
    navSettings: 'Settings',
    navProducts: 'Pipeline',
    navResources: 'Docs',
    footerNote:
      'You do not need to understand the code to use VulnPipe. Every technical term is translated, and the details stay folded until you ask for them.',
    languageLabel: 'Language',
    menu: 'Menu',
  },
  launcher: {
    title: 'What do you want to check?',
    kicker: 'Start a scan',
    tabs: { directory: 'A folder', file: 'A single file', github: 'A GitHub repo' },
    question: {
      directory: 'Which folder do you want to check?',
      file: 'Which file do you want to check?',
      github: 'Which repository do you want to check?',
    },
    help: {
      directory:
        'Your project folder, on your computer. This is the common case: everything inside gets reviewed.',
      file: "Handy right after you write or change one file. The rest of your project is still read for context, but only this file is audited — faster and cheaper.",
      github:
        'Paste the address of a public repository. We fetch a temporary copy, analyze it, then delete it. Private repositories will not work: clone it locally first, then pick "A folder".',
    },
    placeholder: {
      directory: '/Users/me/my-project',
      file: '/Users/me/my-project/src/orders.controller.ts',
      github: 'https://github.com/user/project',
    },
    missingTarget: 'Tell us what to analyze to continue.',
    scopeLegend: 'How much of it?',
    fullTitle: 'The whole project',
    fullHelp: 'Slower and more expensive, but nothing is left out. Do this the first time.',
    incrementalTitle: 'Only what changed',
    incrementalHelp:
      'Much faster and cheaper: we only re-check the parts modified since a given version. This is the everyday mode.',
    commitLabel: 'Since which version?',
    commitHelp:
      'The reference of the save point to compare against. If you do not know it, leave it empty: the whole project will be analyzed, and we will tell you.',
    commitPlaceholder: 'leave empty if you are not sure',
    submit: 'Estimate, then analyze',
    submitBusy: 'One moment...',
    reassurance: 'Nothing starts yet: we show you the time and cost first.',
  },
  estimate: {
    title: 'Before we start: here is what this means',
    kicker: 'Estimate',
    time: 'Time',
    cost: 'Cost',
    routes: 'Addresses checked',
    calls: 'AI calls',
    routesHint: (noAi, withAi) => `${noAi} settled without AI, ${withAi} sent to a model`,
    callsHint: 'the only billed item',
    costFree: 'Free',
    costUnknown: 'Not priceable',
    costUnknownHint: 'rate not configured',
    costHint: 'an estimate, not an invoice',
    lessThanCent: 'less than a cent',
    targetKind: { directory: 'Folder', file: 'Single file', github: 'GitHub repo' },
    targetLine: (files, routes) => `${files} file(s) read, ${routes} address(es) found`,
    incrementalNote: 'only what changed',
    detailShow: 'What is this estimate based on?',
    detailHide: 'Hide',
    detailIntro:
      'This is not guesswork: we actually read your code, linked the pieces together and prepared the questions for the AI. The only thing we did not do is ask them — that is the only step that costs money.',
    detailSampled: (size) =>
      ` The first ${size} addresses were measured for real, the rest is extrapolated.`,
    volume: (thousands) => `Estimated volume: about ${thousands} thousand machine-words processed.`,
    confirm: 'Start the analysis',
    confirmBusy: 'Starting...',
    nothingToScan: 'Nothing to analyze',
    cancel: 'Change target',
    estimating: 'Reading your code to price the work. Nothing is spent during this step.',
  },
  live: {
    title: 'Analysis running',
    finished: 'Analysis complete',
    examining: 'Examining',
    progress: (done, total) => `${done} address(es) of ${total}`,
    countersAlerts: 'likely problem(s)',
    countersGrey: 'to double-check',
    countersSafe: 'all clear',
    countersCalls: 'AI call(s)',
    countersFree: (n) => ` · ${n} settled without AI`,
    countersCached: (n) => ` · ${n} already known`,
    countersSpent: 'spent',
    countersNotReported: ' (not reported)',
    waiting: 'The first verdicts will show up here, address by address.',
    feedLabel: 'Verdicts as they come in',
    zoneSafe: 'All clear',
    zoneGrey: 'To double-check',
    zoneAlert: 'Likely problem',
    zoneFailed: 'Could not be checked',
  },
  timeline: {
    heading: 'The main steps',
    headingDone: 'What happened',
    empty: 'The analysis is about to start. You will see here, step by step, what is being checked.',
    showDetail: 'Show technical detail',
    hideDetail: 'Hide technical detail',
    statusRunning: 'running',
    statusDone: 'done',
    statusFailed: 'problem encountered',
    statusSkipped: 'step skipped',
    statusPending: 'waiting',
    of: (done, total) => `${done} of ${total}`,
    fallback: 'A step of the analysis is running...',
  },
  steps: {
    received: {
      label: 'Request received',
      icon: 'inbox',
      running: 'Registering your request...',
      done: 'Request received. Here we go.',
      failed: 'We could not take your request into account.',
      why: 'We log your request and queue it. If several analyses run at once, each keeps its place in line.',
      analogy: 'Like taking a ticket when you walk into a waiting room.',
    },
    indexing: {
      label: 'Reading your code',
      icon: 'book',
      running: 'Reading your code structure to find every page and address in your application...',
      done: 'We covered your whole application.',
      failed: 'We could not read your code. The analysis stops here.',
      why: 'Before hunting for holes, you have to know what there is to protect. We list every address in your application: each page, each button that fetches data.',
      analogy: 'Like walking around a house counting doors and windows before checking the locks.',
    },
    context_server: {
      label: 'Connecting the dots',
      icon: 'link',
      running: 'Linking the pieces of code together to understand what each page really does...',
      done: 'The links between the parts of your code are mapped.',
      failed: 'The links between the parts of your code could not be established.',
      why: 'An address on its own says nothing. You have to follow what it triggers: which data it fetches, and whether a protection runs first. We reconstruct that whole path.',
      analogy: 'Like following a wire from the switch to the bulb to see what it controls.',
    },
    detection: {
      label: 'Hunting for holes',
      icon: 'search',
      running:
        "Checking that nobody can read another user's data just by changing a number in the address...",
      done: 'Every address in your application has been checked.',
      failed: 'Some addresses could not be checked: this scan is incomplete.',
      why: 'This is the core of the work. For each address, we look at whether somebody could reach data that is not theirs. The obvious cases are settled without any AI, so you are not billed for nothing.',
      analogy: 'Like trying the handles yourself to see which ones open without a key.',
    },
    aggregation: {
      label: 'Sorting the results',
      icon: 'filter',
      running: 'Grouping reports, dropping duplicates and obvious false leads...',
      done: 'Sorting done: only what deserves a look is left.',
      failed: 'Sorting the results failed.',
      why: 'Several checks can flag the same problem, and some reports point at test code that never actually runs. We clean all that up so only what matters is kept.',
      analogy: 'Like sorting your mail: you bin the flyers before reading the rest.',
    },
    master_review: {
      label: 'Second opinion',
      icon: 'scale',
      running:
        'A second, more capable intelligence is reviewing the remaining points to rule out false alarms...',
      done: 'The review is complete.',
      failed: 'The review could not finish: some points are shown without a second check.',
      why: 'Quick checks get it wrong sometimes. A more capable intelligence re-reads the doubtful cases against the real code and drops the false alarms. That is what keeps us from bothering you for nothing.',
      analogy: 'Like asking for a second opinion before an important decision.',
    },
    report: {
      label: 'Your report',
      icon: 'document',
      running: 'Writing your report in plain language...',
      done: 'Your report is ready.',
      failed: 'The analysis stopped before it could produce a complete report.',
      why: 'We translate everything into plain language: what an attacker could concretely do, and which direction to look for the fix.',
      analogy: 'Like a write-up meant for you, not for another specialist.',
    },
  },
  explainer: {
    title: 'How the analysis works',
    intro: 'How we go about it',
    lede: 'Seven steps, from reading your code to the report written for you. Open any of them to see what it is for.',
    now: 'running',
    show: 'What is this for?',
    hide: 'Hide',
    costTitle: 'Why this costs almost nothing',
    costBody:
      'Most addresses in your application are settled by automatic checks that use no AI at all — zero tokens. Only the genuinely doubtful cases are sent to a model, and only the most ambiguous ones reach the more capable, more expensive one. That is where your tokens go, and you get the exact breakdown at the end of every analysis.',
  },
  report: {
    heading: 'Your report',
    securityIssue: 'Security issue',
    whatToDo: 'What to do: ',
    noticeNotArbitrated:
      'This point could not be double-checked. It is shown as-is: have somebody confirm it before drawing conclusions.',
    noticeNeedsHuman:
      'The second review could not settle it: some elements are missing from your code to be sure. A human check is needed.',
    noticeSummaryOnly:
      'This point was re-checked without full access to the code: treat it with caution.',
    showTechnical: 'Show technical detail',
    hideTechnical: 'Hide technical detail',
    whyVerdict: 'Why this verdict',
    referenceCategory: 'Reference category',
    problemType: 'Type of problem',
    whereLabel: 'Where',
    codeHeading: 'The code involved',
    codeUnavailable: 'We could not read the code at this spot.',
    codeTruncated: 'Some lines were shortened to stay readable.',
    copyFixPrompt: 'Copy a fix request',
    copyFixPromptHelp:
      'Copies a ready-made request — the code, the diagnosis and what to ask — to paste into the AI assistant you code with.',
    copied: 'Copied',
    copyFailed: 'Copy failed. Select the text and copy it by hand.',
    openInEditor: (editor) => `Open in ${editor}`,
    openInEditorHelp: 'Opens the file at the right line, if that editor is installed.',
    copyReport: 'Copy the report',
    downloadReport: 'Download',
    exportHelp:
      'To keep a record, attach it to a ticket, or show it to someone who can help you.',
    reportCopied: 'Report copied',
    countCritical: (n) => `${n} to fix now`,
    countWarning: (n) => `${n} to keep an eye on`,
    countDismissed: (n) => (n === 1 ? '1 false alarm dropped' : `${n} false alarms dropped`),
    nothing: {
      titleClear: 'No flaw found',
      titlePartial: 'No flaw found in what we could check',
      titleUnknown: 'Nothing kept, coverage not reported',
      lede: 'An empty report is a result, not an absence — but it only speaks about what was read. Here is exactly what that was.',
      scope: 'What we read',
      files: (n) => (n === 1 ? '1 file indexed' : `${n} files indexed`),
      routesFound: (n) => (n === 1 ? '1 address found' : `${n} addresses found`),
      routesAnalyzed: (n) => (n === 1 ? '1 address analysed' : `${n} addresses analysed`),
      failed: (n) => (n === 1 ? '1 address could not be analysed' : `${n} addresses could not be analysed`),
      modeFull: 'The whole project',
      modeIncremental: 'Only what changed',
      caveatIncremental:
        'Only the parts modified since the given version were re-checked. This says nothing about the rest of the project — run a whole-project scan for that.',
      caveatFailed:
        'Those addresses were not read. Nothing is known about them, one way or the other, and they are not covered by the sentence above.',
      dismissed: (n) =>
        n === 1
          ? '1 candidate was found and dropped by the second opinion'
          : `${n} candidates were found and dropped by the second opinion`,
      dismissedFold: 'Which ones',
      unknown:
        'This scan did not report what it covered, so how much the empty result is worth cannot be said here.',
    },
    analysis: 'Analysis',
    lineSuffix: (line) => ` (line ${line})`,
  },
  status: {
    heading: 'Status:',
    labels: {
      open: 'to handle',
      fixed: 'fixed',
      accepted: 'risk accepted',
      false_positive: 'false alarm',
    },
    noteLabel: (status) => `Why "${status}"?`,
    notePlaceholder: 'One sentence is enough. Your future self will thank you.',
    noteRequired: 'Say why before setting this status: in six months nobody will remember.',
    confirm: 'Save',
    cancel: 'Cancel',
    staleWarning:
      'You marked this as fixed, but this scan still finds it. Either the fix does not cover this spot, or it has not been applied here.',
    summaryHeading: 'Where you stand',
    fixRate: (percent) => `${percent}% of what needed handling is fixed`,
    nothingToTreat: 'Nothing left to handle.',
    dismissedCount: (n) => `${n} point(s) set aside by you (still shown below)`,
    excludedNote:
      'Points you set aside count neither as fixed nor as remaining: setting a problem aside never improves this figure.',
  },
  usage: {
    heading: 'What this scan actually used',
    calls: 'AI analys(es)',
    cost: 'cost',
    compute: 'of compute',
    showDetail: 'Show usage detail',
    hideDetail: 'Hide usage detail',
    byStage: 'By step',
    stage: 'Step',
    callsColumn: 'Calls',
    input: 'Input',
    output: 'Output',
    thinking: 'Thinking',
    thinkingNote:
      '“Thinking” is the model reasoning to itself before it writes its answer. '
      + 'It is billed like the rest, and it is often the largest line.',
    costColumn: 'Cost',
    notReported: 'not reported by the provider',
    free: 'no tokens used',
    byModel: 'By model',
    model: 'Model',
    partial: 'partial',
    stages: { detection: 'Hunting for holes', master_review: 'Second opinion' },
  },
  providers: {
    heading: 'Which AI engine?',
    intro:
      'Two roles, set separately. Detection does the bulk of the work; the second opinion only handles the doubtful cases.',
    detectionRole: 'Hunting for holes',
    detectionHelp: 'Runs on every address. This is where the volume — and the cost — is.',
    arbitrationRole: 'Second opinion',
    arbitrationHelp: 'Only sees the doubtful cases. Worth picking the most capable one here.',
    model: 'Model (optional)',
    modelPlaceholder: 'provider default',
    unavailable: 'access key missing',
    keyMissing: ' — key missing',
    cannotUse: (why) => `This provider cannot be used right now: ${why}`,
    apply: 'Apply',
    applying: 'Applying...',
    lockedDuringScan: 'A scan is running: the setting is frozen until it finishes.',
    modelHint:
      'Listed from the least token-hungry to the most capable. A lighter model settles simple cases for far fewer tokens; the most capable one is worth it on genuinely ambiguous code.',
    effortLabel: 'Thinking depth',
    effortHint:
      'How long the model reasons before answering. Deeper thinking burns tokens you never see in the answer — that is where most of the consumption goes. Leave it on the model default unless you have a reason.',
    effortNames: {
      default: "Model default (don't force it)",
      low: 'Minimal — fewest tokens, fastest',
      medium: 'Moderate',
      high: 'Deep — the usual default',
      xhigh: 'Deeper — noticeably more tokens',
      max: 'Maximum — most tokens, for the hardest cases',
    },
    names: {
      gemini: 'Google Gemini',
      ollama: 'Ollama (on your machine)',
      anthropic: 'Claude (Anthropic)',
      'claude-subscription': 'My Claude subscription',
      openai: 'OpenAI',
      openrouter: 'OpenRouter',
      custom: 'Custom server',
    },
    descriptions: {
      gemini: 'Fast and cheap. One key is enough.',
      ollama: 'Free and private: nothing leaves your computer.',
      anthropic: 'The most reliable for settling ambiguous cases.',
      'claude-subscription':
        'Uses the Claude Pro or Max plan you already pay for, through Claude Code on this machine. No API key, nothing extra billed per call.',
      openai: 'GPT models.',
      openrouter: 'Access to many models, from the very cheap to the most capable.',
      custom: 'Any OpenAI-compatible server you host yourself.',
    },
  },
  landing: {
    kicker: 'Automated security pipeline',
    title: 'Ship code.',
    titleEm: 'Not holes.',
    lede:
      'VulnPipe reads the code you write — or the code an AI wrote for you — and tells you, in plain language, where somebody could get to data that is not theirs. No security background required, no raw report to decipher.',
    ctaPrimary: 'Analyze my project',
    ctaSecondary: 'See how it works',
    stats: [
      { value: '7', label: 'steps, all visible while they run' },
      { value: '10-15%', label: 'of findings ever reach the most capable model' },
      { value: '0', label: 'lines of JSON you have to read' },
    ],
    problemKicker: 'The problem',
    problemTitle: 'Code ships faster than it gets checked',
    problemLede:
      'Generating a working feature now takes minutes. Reviewing whether it leaks other people’s data still takes a specialist. That gap is where VulnPipe lives.',
    problems: [
      {
        title: 'Working is not the same as safe',
        body: 'A route that returns an order by its number works perfectly in your tests — where you only ever ask for your own orders. Nothing in the tests tells you that number 1042 belongs to somebody else.',
      },
      {
        title: 'Classic tools speak to specialists',
        body: 'Standard scanners output rule identifiers, severity matrices and stack traces. They assume you already know what to do with them. If you do not, the output is noise.',
      },
      {
        title: 'And they cost a fortune to run on every commit',
        body: 'Running a large model over an entire codebase at every push is what makes AI security tools expensive. Most of that work is spent confirming code that was obviously fine.',
      },
    ],
    flowKicker: 'Architecture',
    flowTitle: 'What actually happens to your code',
    flowLede:
      'Your code is read locally, understood as a graph, examined by specialised detectors, then filtered. Only the genuinely ambiguous cases are sent to the more capable model — and you see the whole path while it runs.',
    flowCaption:
      'Everything on the left of the filter runs on your machine or on low-cost models. The step that really spends tokens is the last one, and it only ever sees a shortlist.',
    diagram: {
      localLabel: 'Local — no tokens',
      cloudLabel: 'Paid — shortlist only',
      commit: 'Your code',
      commitNote: 'a folder, a file, or a public repository',
      indexer: 'Indexer',
      indexerNote: 'lists every address, function and call',
      mcp: 'Context server',
      mcpNote: 'serves the surrounding code on demand',
      nodes: 'Detectors',
      nodesNote: 'one per hole type, run in parallel',
      aggregator: 'Filter',
      aggregatorNote: 'deduplicates, scores, routes by confidence',
      master: 'Second opinion',
      masterNote: 'settles the ambiguous cases against the real code',
      report: 'Your report',
      reportNote: 'plain language, technical detail folded',
      free: 'settled without AI',
      billed: 'sent to a model',
      dropped: 'dropped as noise',
    },
    stepsKicker: 'Step by step',
    stepsTitle: 'The seven steps, explained',
    stepsLede:
      'Each one is announced on screen while it runs, with what it is for. Nothing happens behind a spinner.',
    zonesKicker: 'Confidence',
    zonesTitle: 'Three zones, not a yes/no',
    zonesLede:
      'Every detector returns a confidence score rather than a verdict. That single decision is what keeps the cost down and the false alarms out: certainty costs no tokens, doubt is what deserves a second look.',
    zones: [
      {
        range: '0.0 - 0.3',
        title: 'Clean',
        body: 'The check is conclusive on its own. The pipeline stops here, nothing is sent anywhere, nothing is billed.',
        tone: 'green',
      },
      {
        range: '0.4 - 0.7',
        title: 'Grey zone',
        body: 'Either context is missing, or the business logic is genuinely debatable. This is what the second opinion is for — and it is the only thing worth paying for.',
        tone: 'orange',
      },
      {
        range: '0.8 - 1.0',
        title: 'Near certain',
        body: 'The hole is plain in the code. It is reported directly, and can optionally skip the second opinion entirely to save time and money.',
        tone: 'red',
      },
    ],
    costKicker: 'Economics',
    costTitle: 'Why this costs almost nothing',
    costLede:
      'The most capable model is not a scanner, it is a referee. It is called once, at the end, on what survived every check that cost nothing.',
    funnel: [
      { label: 'Addresses found in your code', note: 'read locally, no tokens', share: 100 },
      { label: 'Suspicious enough to look at', note: 'pattern checks, still no tokens', share: 45 },
      { label: 'Examined by a local or cheap model', note: 'the bulk of the analysis', share: 25 },
      { label: 'Sent to the most capable model', note: 'the only step that really spends', share: 12 },
    ],
    costPoints: [
      {
        title: 'You see the bill before it exists',
        body: 'Every scan starts with an estimate: addresses to check, calls needed, time and cost. Nothing is spent until you accept it.',
      },
      {
        title: 'The obvious cases never reach a model',
        body: 'A route with no user input and no database access is settled by a deterministic check. Free, instant, and impossible to hallucinate.',
      },
      {
        title: 'Two engines, set separately',
        body: 'The detector that runs on every address and the referee that runs once are configured independently — put the cheap model where the volume is.',
      },
      {
        title: 'Everyday scans only look at what changed',
        body: 'After the first full pass, incremental mode re-checks only the routes touched since a given version. That is the mode you live in.',
      },
    ],
    coverageKicker: 'Coverage',
    coverageTitle: 'What we check today',
    coverageLede:
      'We would rather do four things properly than claim ten. Here is the honest state of the detectors — what runs now, and what is next.',
    coverageColumns: { name: 'Check', what: 'What it catches', status: 'Status' },
    coverage: [
      {
        name: 'IDOR',
        what: 'Someone reads or edits another user’s data by changing a number in the address.',
        live: true,
      },
      {
        name: 'SQL injection',
        what: 'Someone makes your database run their own commands through a form or a URL.',
        live: false,
      },
      {
        name: 'XSS',
        what: 'Someone injects code that runs in your other visitors’ browsers.',
        live: false,
      },
      {
        name: 'Security misconfiguration',
        what: 'A protection is missing or misconfigured, leaving a door open.',
        live: false,
      },
    ],
    statusLive: 'Available',
    statusPlanned: 'Planned',
    rulesKicker: 'Our rules',
    rulesTitle: 'Four commitments we design against',
    rules: [
      {
        title: 'Plain language first, always',
        body: 'Every finding carries a human summary: what somebody could actually do, and which direction to fix it. Technical detail exists, but it stays folded until you ask.',
      },
      {
        title: 'An unchecked address is never called safe',
        body: 'If a detector fails on a route, it is reported as a failure. A partial scan that looks complete is worse than no scan.',
      },
      {
        title: 'Your code stays where you put it',
        body: 'Indexing runs on your machine. Detection can run entirely on a local model. A public repository is cloned to a temporary copy and deleted afterwards.',
      },
      {
        title: 'Nothing is spent without your word',
        body: 'The estimate step reads your code and prices the work without calling a single model. You decide whether it happens.',
      },
    ],
    faqKicker: 'Questions',
    faqTitle: 'What people ask first',
    faq: [
      {
        q: 'Do I need to understand security to read the report?',
        a: 'No. Every finding is written for someone who does not code: what an attacker could do, and where to look for the fix. Technical terms never appear alone — each one is translated on the spot.',
      },
      {
        q: 'Does my code leave my machine?',
        a: 'Reading and indexing are always local. Whether anything leaves depends on the engine you pick in Settings: a local model keeps everything on your computer, a hosted one sends the relevant snippets of code. A public repository you point us at is cloned temporarily and deleted after the scan.',
      },
      {
        q: 'What does a scan actually cost?',
        a: 'You get the number before you commit to it. Only calls to hosted models spend tokens; the deterministic checks and any model running on your own machine spend none. Everyday incremental scans usually land in the fractions of a cent.',
      },
      {
        q: 'Will it flood me with false alarms?',
        a: 'That is what the filter and the second opinion exist for. Findings below the confidence floor are dropped, duplicates are merged, and the ambiguous ones are re-read against the real code before you ever see them.',
      },
      {
        q: 'Which languages does it support?',
        a: 'JavaScript and TypeScript today, including Express and NestJS style routes. The engine is language-agnostic by design, so other languages come without rewriting the pipeline.',
      },
    ],
    finalTitle: 'Point it at your project',
    finalBody:
      'You will get an estimate first, then a running commentary, then a report you can actually act on.',
    finalCta: 'Start an analysis',
  },
  settings: {
    heading: 'Settings',
    lede:
      'Everything here changes how the next scan behaves. Nothing is applied to a scan already running.',
    savedLocally: 'Kept in this browser',
    savedOnServer: 'Applied on the server',
    scanKicker: 'Defaults',
    scanTitle: 'How scans start',
    scanLede: 'Prefill the launcher so the everyday scan is one click away.',
    defaultKindLabel: 'What you usually analyze',
    defaultKindHelp: 'The tab preselected when you open the launcher.',
    defaultModeLabel: 'Default scope',
    defaultModeHelp:
      'Full is the right first pass. Once you have one, "only what changed" is faster and much cheaper.',
    rememberTargetLabel: 'Remember the last target',
    rememberTargetHelp:
      'Prefills the launcher with what you analyzed last time. Stored in this browser only.',
    rememberedTargetNone: 'nothing remembered yet',
    forgetTarget: 'Forget it',
    autoConfirmLabel: 'Skip the estimate under',
    autoConfirmHelp:
      'When the estimated cost is below this amount, the analysis starts without asking. Set it to 0 to always confirm by hand.',
    autoConfirmOff: 'Always ask before starting',
    autoConfirmOn: (amount) => `Starts on its own below ${amount}`,
    keysEditTitle: 'Set a key',
    keysEditLede:
      'Paste a key and it takes effect immediately — nothing to restart. Leave a field empty to keep the key already in place.',
    keyLabel: {
      GEMINI_API_KEY: 'Google Gemini',
      ANTHROPIC_API_KEY: 'Anthropic Claude',
      OPENAI_API_KEY: 'OpenAI',
      OPENROUTER_API_KEY: 'OpenRouter',
      VULNPIPE_LLM_BASE_URL: 'Custom server address',
    },
    keyHelp: {
      GEMINI_API_KEY: 'From Google AI Studio.',
      ANTHROPIC_API_KEY:
        'From the Anthropic console. Setting it disables the Claude subscription option, which would otherwise be free.',
      OPENAI_API_KEY: 'From the OpenAI platform.',
      OPENROUTER_API_KEY: 'From openrouter.ai — one key for many models.',
      VULNPIPE_LLM_BASE_URL:
        'For a local or self-hosted server. Not a key: an address, such as http://localhost:11434/v1.',
    },
    keySet: 'Set',
    keyEmpty: 'Not set',
    keyFromEnv: 'From the environment',
    keyFromDotenv: 'From a .env file',
    keyFromEnvHelp:
      'This value comes from the machine running the analysis service (shell, Docker, CI). It cannot be changed from here: anything typed in would be ignored. Change it where it is defined, then restart the service.',
    keyPlaceholder: 'Paste the key',
    keyPlaceholderKeep: 'Leave empty to keep the current key',
    keyPlaceholderUrl: 'http://localhost:11434/v1',
    keysSave: 'Save keys',
    keysSaving: 'Saving…',
    keysSaved: 'Saved. The engines above are up to date.',
    keyClear: 'Remove',
    keyClearConfirm: (name) => `Remove the ${name} key? Any engine that needs it becomes unavailable.`,
    keysNothingToSave: 'Nothing to save: no field was filled in.',
    keysEffect: 'Stored on the server running the analysis, readable only by it.',
    arbitrationKicker: 'Arbitration',
    arbitrationTitle: 'How findings are routed',
    arbitrationLede:
      'The filter sorts every finding by confidence before anything is billed. These are the thresholds it uses.',
    bypassLabel: 'Report near-certain holes without a second opinion',
    bypassHelp:
      'Findings above 0.7 go straight to your report instead of being re-read by the most capable model. Faster and cheaper.',
    bypassWarning:
      'The second opinion is also what writes the plain-language summary. Skipping it gives you a rawer report.',
    concurrencyTitle: 'Analysis speed',
    concurrencyLabel: 'Addresses checked at the same time',
    concurrencyHelp: (min, max) =>
      `Raising this shortens a scan by about as much, as long as your AI engine keeps up (${min}–${max}). It changes nothing to what is found, or to what it costs — only to how long you wait.`,
    concurrencyWarning:
      'Above 8, a free-tier engine will start refusing calls. Nothing is lost — they are retried — but the wait comes back, which is what you were trying to avoid.',
    cacheKicker: 'Memory',
    cacheTitle: 'What is already known',
    cachePersisted:
      'Answers already given on code that has not changed are kept, and survive a restart. Change one line and the question is asked again — a stored answer can never apply to code that has moved.',
    cacheMemoryOnly:
      'Kept for this session only: a restart clears it, and the next scan pays again for everything.',
    cacheDetection: 'addresses already answered',
    cacheArbitration: 'second opinions already given',
    cacheHits: 'answers reused instead of paid for',
    cacheRestoreFailed: (kind, why) =>
      `The "${kind}" memory could not be picked up again (${why}). Nothing is broken: the next scan simply pays for what it could have skipped.`,
    cacheForgetHelp:
      'Forgetting everything costs you a scan at full price, and nothing else. Do it if you suspect an answer is stuck on code you have already fixed.',
    cacheForget: 'Forget everything',
    cacheForgetting: 'Forgetting...',
    thresholdsTitle: 'Confidence thresholds',
    thresholdsLede: 'Fixed by design, shown so you know what happens to a finding.',
    displayKicker: 'Display',
    displayTitle: 'What you see',
    displayLede: 'Reading preferences. They change nothing to what is analyzed.',
    editorLabel: 'My code editor',
    editorHelp:
      'Which editor the "open the file" link on a finding should launch. Nothing is installed or detected: pick the one you use.',
    technicalByDefaultLabel: 'Open technical detail by default',
    technicalByDefaultHelp:
      'Findings normally show the plain summary first. Turn this on if you read the code yourself.',
    explanationsLabel: 'Show "what is this for?" on every step',
    explanationsHelp: 'Keeps the per-step explanations unfolded during a scan.',
    languageLabel: 'Language',
    languageHelp: 'Applies to the interface and to everything the server writes for you.',
    systemKicker: 'System',
    systemTitle: 'Status',
    systemLede: 'What the interface can reach right now.',
    serverLabel: 'Analysis service',
    serverOnline: 'reachable',
    serverOffline: 'unreachable',
    serverChecking: 'checking...',
    recheck: 'Check again',
    keysTitle: 'Engine access',
    keysLede: 'An engine without a key cannot be selected. This is what is configured on the server.',
    keyReady: 'ready',
    keyMissing: 'no key',
    resetTitle: 'Reset',
    resetHelp: 'Clears every preference kept in this browser. Server settings are untouched.',
    reset: 'Reset my preferences',
    resetDone: 'Preferences cleared.',
    on: 'On',
    off: 'Off',
  },
  severity: {
    critical: {
      label: 'Fix soon',
      explanation: 'If somebody notices, the damage can be immediate and significant.',
    },
    high: {
      label: 'Fix soon',
      explanation: 'If somebody notices, the damage can be immediate and significant.',
    },
    medium: { label: 'Keep an eye on it', explanation: 'Not urgent, but worth a look.' },
    low: { label: 'Minor', explanation: 'Limited impact, handle it when you have time.' },
    info: { label: 'For information', explanation: 'Nothing to fix, flagged so you know.' },
  },
  glossary: {
    IDOR: "A visitor can reach somebody else's data just by changing a number in the page address.",
    SQLI: "A visitor can make your application's database run their own commands.",
    XSS: "A visitor can slip in code that runs in other visitors' browsers.",
    SSRF: 'A visitor can force your server to fetch pages or data it should not reach.',
    SECURITY_MISCONFIGURATION: 'A security setting is missing or wrong, leaving a door open.',
    OWASP:
      'An organisation that publishes the reference list of the most common web security holes.',
    'A01:2021 – Broken Access Control':
      'Reference category: the controls deciding "who may see what" are not strong enough.',
  },
  errors: {
    unreachable: 'Cannot reach the analysis service. Check that it is running.',
    generic: 'That did not go through.',
    unreadable: 'The analysis service answered something unexpected. Nothing was read from it.',
    streamLost: 'The live feed dropped. The result is still available.',
    scanInterrupted: 'The analysis stopped before producing a report.',
  },
  restart: 'Run another analysis',
};


const CATALOG: Record<Locale, Dictionary> = { en: EN };

export function dictionary(locale: Locale): Dictionary {
  return CATALOG[locale];
}

export const STEP_ORDER: StepName[] = [
  'received',
  'indexing',
  'context_server',
  'detection',
  'aggregation',
  'master_review',
  'report',
];
