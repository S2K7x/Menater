/**
 * Catalogue des messages destinés à l'utilisateur, côté serveur.
 *
 * ============================================================================
 * POURQUOI UNE INTERFACE PLUTÔT QU'UN OBJET DE CHAÎNES
 *
 * Le catalogue est typé par `Messages`, et chaque langue doit satisfaire cette
 * interface. Ajouter une clé sans la traduire ne compile pas. C'est le seul
 * garde-fou qui tienne dans la durée : une table de traductions vérifiée à la
 * main dérive au troisième ajout, et l'utilisateur découvre le trou en
 * production, sous la forme d'une phrase anglaise au milieu d'un écran
 * français.
 *
 * Les messages à paramètres sont des FONCTIONS, pas des gabarits à trous. Le
 * français et l'anglais n'accordent pas au même endroit ni sur les mêmes
 * règles ; une fonction laisse chaque langue gérer ses pluriels sans imposer
 * la grammaire de l'autre.
 * ============================================================================
 */

import { plural, type Locale } from './locale.ts';

export interface Messages {
  /** Ce qu'on analyse : dossier, fichier, dépôt. */
  target: {
    empty: string;
    notFound: (raw: string) => string;
    directory: (label: string) => string;
    file: (file: string) => string;
    fileContextWarning: (root: string, file: string) => string;
    github: (label: string) => string;
    cloneFailed: (label: string) => string;
  };

  /** Progression de la pipeline. */
  scan: {
    received: string;
    indexingRunning: string;
    indexingFailed: string;
    indexingDone: (files: number, routes: number, target: string) => string;
    contextDone: string;
    detectionIntro: string;
    routeExamining: (method: string, route: string) => string;
    routeProgress: (done: number, total: number) => string;
    routeFailed: (method: string, route: string) => string;
    detectionDone: (routes: number) => string;
    detectionPartial: (failures: number) => string;
    /** Ce que le scan n'a pas eu à repayer, et pour quelle raison. */
    detectionSavings: (free: number, cached: number, total: number) => string;
    aggregationRunning: string;
    aggregationDone: (rejected: number, candidates: number) => string;
    arbitrationNothing: string;
    arbitrationRunning: (candidates: number) => string;
    arbitrationDone: string;
    arbitrationPartial: (count: number) => string;
    arbitrationReused: (count: number) => string;
    reportRunning: string;
    interrupted: string;
    readFailed: string;
    usageCounter: (calls: number, thousandWords: number, costUsd: number | null) => string;
    noCommit: string;
    diffUnavailable: string;
    nothingChanged: string;
    changeNotAttributable: (examples: string[], total: number) => string;
  };

  /** Devis avant scan. */
  estimate: {
    nothingToScan: string;
    noRoutesFound: string;
    willCheck: (routes: number) => string;
    freeRoutes: (count: number) => string;
    billedRoutes: (count: number) => string;
    duration: (low: string, high: string) => string;
    isFree: string;
    costRange: (low: string, high: string) => string;
    costSingle: (value: string) => string;
    lessThanACent: string;
    costUnknown: string;
    priceMissing: (providers: string, envVar: string) => string;
    sampled: (probed: number, remaining: number) => string;
    arbitrationShare: (low: number, high: number) => string;
    latencyMeasured: (samples: number, seconds: number) => string;
    latencyEstimated: (seconds: number) => string;
    parallelism: (concurrency: number, waves: number) => string;
    probeFailures: (count: number) => string;
    /** Unités de durée, pour composer « 3 minutes ». */
    seconds: (n: number) => string;
    minutes: (n: number) => string;
    hours: (n: number, minutes: number) => string;
    cents: (value: string) => string;
    dollars: (value: string) => string;
    zero: string;
  };

  /** Consommation réelle, après coup. */
  usage: {
    noLlm: string;
    calls: (calls: number, thousandWords: number) => string;
    costTotal: (amount: string) => string;
    costPartial: (amount: string) => string;
    costUnknown: string;
    free: string;
    thinkingHeavy: string;
    models: (list: string) => string;
  };

  /** Disponibilité des fournisseurs de modèles. */
  providers: {
    missingKey: (envVar: string) => string;
    missingAnthropic: string;
    missingClaudeCode: string;
    unknownEffort: (value: string) => string;
    apiKeyShadowsSubscription: string;
    missingBaseUrl: string;
    unusable: string;
    invalidSetting: string;
    unknownProvider: (id: string) => string;
    fallback: (role: 'detection' | 'arbitration', wanted: string, used: string) => string;
  };

  /** Saisie des clés de moteur depuis les Réglages. */
  providerKeys: {
    unknownKey: (name: string) => string;
    invalidValue: (name: string) => string;
    lockedByEnvironment: (name: string) => string;
    writeFailed: (detail: string) => string;
  };

  /** Réponses de l'API. */
  api: {
    targetMissing: string;
    unknownMode: string;
    estimateExpired: string;
    scanStarted: string;
    estimateFailed: string;
    targetUnreadable: string;
  };

  /** Verdicts du scanner déterministe. */
  scanner: {
    noAttackSurface: (route: string) => string;
    userScoped: (route: string) => string;
    unscopedNoGuard: (route: string) => string;
    needsReview: (route: string) => string;
  };

  /** Agrégation. */
  aggregator: {
    nothingReported: string;
    received: (total: number, retained: number) => string;
    excludedNonProduction: (count: number) => string;
    mergedDuplicates: (count: number) => string;
    rejectedLowConfidence: (count: number) => string;
    criticalCount: (count: number) => string;
    noCritical: string;
    multipleAtSameLocation: (location: string, count: number, names: string) => string;
    and: string;
  };

  /** Rapport final. */
  report: {
    allClear: string;
    foundWithCritical: (total: number, critical: number) => string;
    foundNonUrgent: (total: number) => string;
    dismissed: (count: number) => string;
    notArbitrated: (count: number) => string;
    routesFailed: (count: number) => string;
    coverage: (routes: number) => string;
    suspected: (vulnerability: string, method: string, route: string, score: number) => string;
    patchesDescribedInWords: string;
    patchStripped: (field: string) => string;
  };

  /** Contexte introuvable côté serveur MCP. */
  context: {
    routeUnknown: string;
    listFailed: string;
    refused: string;
  };

  /**
   * Consigne de langue ajoutée aux prompts.
   *
   * Traduire l'interface sans traduire ce que produit le modèle donnerait un
   * écran anglais dont chaque alerte serait rédigée en français : le pire des
   * deux mondes.
   */
  prompt: {
    answerLanguage: string;
  };
}

const EN: Messages = {
  target: {
    empty: 'Tell us what to analyze: a folder, a file, or a GitHub repository URL.',
    notFound: (raw) =>
      `"${raw}" does not exist on your computer and does not look like a GitHub address. Check the path, or paste a link such as https://github.com/user/project.`,
    directory: (label) => `We will analyze everything inside the folder ${label}.`,
    file: (file) =>
      `We will analyze only the file ${file}. The rest of the project is read for context, but is not audited.`,
    fileContextWarning: (root, file) =>
      `The project around your file is read from ${root} to understand what your file calls, but only ${file} is audited.`,
    github: (label) =>
      `We fetched a copy of the ${label} repository to analyze it. That copy is deleted afterwards.`,
    cloneFailed: (label) =>
      `We could not fetch the ${label} repository. If it is private, VulnPipe has no access to it: clone it to your computer first, then point us at the folder.`,
  },

  scan: {
    received: 'We received your request. Here we go.',
    indexingRunning:
      'Fetching your code and reading its structure to find every address in your application...',
    indexingFailed: 'We could not read your code. The analysis stops here.',
    indexingDone: (files, routes, target) =>
      `We read ${files} file(s) and found ${routes} address(es) in ${target}.`,
    contextDone: 'The links between the different parts of your code are mapped.',
    detectionIntro:
      "We are checking that nobody can read another user's data just by changing a number in the address.",
    routeExamining: (method, route) => `Examining ${method} ${route}...`,
    routeProgress: (done, total) => `We checked ${done} address(es) out of ${total}.`,
    routeFailed: (method, route) => `One address could not be checked: ${method} ${route}.`,
    detectionDone: (routes) =>
      `All ${routes} address(es) in your application have been checked.`,
    detectionPartial: (failures) =>
      `Check complete, but ${failures} address(es) could not be analyzed.`,
    detectionSavings: (free, cached, total) => {
      // Deux gratuités distinctes, jamais additionnées en une seule phrase :
      // « settled without the AI » dit ce que les règles couvrent, « already
      // known » dit ce qui n'a pas changé depuis le dernier scan. Les
      // confondre ferait croire à une couverture déterministe qu'on n'a pas.
      const parts: string[] = [];
      if (free > 0) parts.push(`${free} settled without the AI`);
      if (cached > 0) parts.push(`${cached} already known from an earlier scan on this exact code`);
      if (parts.length === 0) return '';
      return `Out of ${total} address(es), ${parts.join(' and ')} — nothing was billed for those.`;
    },
    aggregationRunning:
      'Grouping the reports, dropping duplicates and obvious false leads...',
    aggregationDone: (rejected, candidates) =>
      `${rejected} harmless report(s) dropped, ${candidates} to review.`,
    arbitrationNothing: 'Nothing to review: no doubtful case came up.',
    arbitrationRunning: (candidates) =>
      `A second, more capable intelligence is reviewing the ${candidates} remaining point(s) to rule out false alarms...`,
    arbitrationDone: 'Review complete.',
    arbitrationPartial: (count) =>
      `Partial review: ${count} point(s) could not be double-checked.`,
    arbitrationReused: (count) =>
      `${count} point(s) had already been reviewed on this exact code: we reused those conclusions instead of paying for them again.`,
    reportRunning: 'Writing your report in plain language...',
    interrupted: 'The analysis stopped before it could produce a report.',
    readFailed: 'We could not read your code. The analysis stops here.',
    usageCounter: (calls, thousandWords, costUsd) => {
      const cost =
        costUsd === null
          ? ''
          : costUsd === 0
            ? ' — no tokens billed so far'
            : ` — $${costUsd.toFixed(4)} spent so far`;
      return `${calls} call(s) to the AI, about ${thousandWords} thousand words processed${cost}.`;
    },
    noCommit:
      'No commit reference given: we cannot tell what changed, so the whole project was analyzed.',
    diffUnavailable:
      'Changes could not be determined (project not under version control, or unknown commit): the whole project was analyzed.',
    nothingChanged: 'No address is affected by this commit: nothing to re-check.',
    changeNotAttributable: (examples, total) => {
      const list = examples.join(', ');
      const rest = total > examples.length ? ` and ${total - examples.length} other file(s)` : '';
      return `We could not tell which addresses depend on ${list}${rest}, so the whole project was analyzed rather than risk missing something.`;
    },
  },

  estimate: {
    nothingToScan:
      'Nothing to analyze: none of your application addresses are affected by what you changed. This scan will be instant and will not spend a single token.',
    noRoutesFound:
      'We found no address to analyze here. Check that you pointed at the right folder — VulnPipe looks for web routes (controllers, API entry points).',
    willCheck: (routes) =>
      `We are going to check ${routes} address${plural(routes, '', 'es')} in your application.`,
    freeRoutes: (count) =>
      count === 1
        ? 'One of them will be settled by the automatic checks, with no AI involved: it costs nothing.'
        : `${count} of them will be settled by the automatic checks, with no AI involved: those cost nothing.`,
    billedRoutes: (count) =>
      count === 1
        ? 'One needs an AI opinion, because the case is not clear-cut.'
        : `${count} need an AI opinion, because the cases are not clear-cut.`,
    duration: (low, high) => `Expect roughly ${low} to ${high}.`,
    isFree: 'This scan costs you nothing: the engine you picked does not bill tokens.',
    costRange: (low, high) => `Estimated cost: between ${low} and ${high}.`,
    costSingle: (value) => `Estimated cost: about ${value}.`,
    lessThanACent: 'In other words, less than one cent.',
    costUnknown:
      'The price cannot be worked out: the rate for the engine you picked is not configured. The workload itself is measured above.',
    priceMissing: (providers, envVar) =>
      `The rate for ${providers} is not configured. Add it to .env (for example ${envVar}="0.30/2.50", in dollars per million input then output tokens) to see a priced estimate.`,
    sampled: (probed, remaining) =>
      `The first ${probed} addresses were measured for real; the other ${remaining} are extrapolated from that average.`,
    arbitrationShare: (low, high) =>
      `Between ${low}% and ${high}% of reports should need a second review — that is the range the design aims for, and it depends on what is actually found.`,
    latencyMeasured: (samples, seconds) =>
      `Engine speed measured over your last ${samples} calls (${seconds}s per address).`,
    latencyEstimated: (seconds) =>
      `Engine speed estimated at ${seconds}s per address: it will be measured for real on your first scan.`,
    parallelism: (concurrency, waves) =>
      `${concurrency} addresses are checked at the same time, so the wait is about ${waves} round(s) rather than one per address.`,
    probeFailures: (count) =>
      `${count} sampled address(es) could not be read. They will most likely stay unanalyzed: they will not be counted as safe.`,
    seconds: (n) => `${n} second${plural(n, '', 's')}`,
    minutes: (n) => `${n} minute${plural(n, '', 's')}`,
    hours: (n, minutes) => (minutes > 0 ? `${n}h ${minutes}` : `${n} hour${plural(n, '', 's')}`),
    cents: (value) => `${value} cents of a dollar`,
    dollars: (value) => `$${value}`,
    zero: '$0',
  },

  usage: {
    noLlm:
      'This scan used no artificial intelligence at all: everything was settled by the automatic checks, at no cost.',
    calls: (calls, thousandWords) =>
      `This scan needed ${calls} AI analys${plural(calls, 'is', 'es')}, for about ${thousandWords} thousand words processed.`,
    costTotal: (amount) => `Total cost: ${amount}.`,
    costPartial: (amount) =>
      `Cost known for part of the calls: ${amount} (some providers do not report their prices).`,
    costUnknown:
      'The provider used does not report cost: only the volume processed can be measured.',
    free: 'nothing billed',
    thinkingHeavy:
      "Most of what you paid for is the model's internal reasoning, not the text it produced: that is normal, but that is where the budget goes.",
    models: (list) => `Model(s) used: ${list}.`,
  },

  providers: {
    missingKey: (envVar) => `${envVar} is not set. You can paste it in Settings.`,
    missingAnthropic:
      'ANTHROPIC_API_KEY is not set — you can paste it in Settings (an `ant auth login` session also works, but cannot be detected here).',
    unknownEffort: (value) =>
      `"${value}" is not a thinking depth. Pick one of: low, medium, high, xhigh, max.`,
    missingClaudeCode:
      'Claude Code was not found on this machine. Install it and sign in with your Claude account, then this option uses your subscription instead of a paid key.',
    apiKeyShadowsSubscription:
      'An API key in your environment takes priority over your Claude subscription: usage would be billed per call. Remove ANTHROPIC_API_KEY to use your subscription.',
    missingBaseUrl: 'VULNPIPE_LLM_BASE_URL is not set: point it at your server address in Settings.',
    unusable:
      'That provider cannot be used right now: its access key is missing. Your previous setting is kept.',
    invalidSetting: 'That setting cannot be used as it stands. Your previous setting is kept.',
    unknownProvider: (id) => `Unknown provider: ${id}`,
    fallback: (role, wanted, used) =>
      `${role === 'detection' ? 'Vulnerability detection' : 'The final review'} was set to use ${wanted}, whose access key is missing. We are using ${used} instead — you can change this in Settings.`,
  },

  providerKeys: {
    unknownKey: (name) => `${name} is not a key this page can set.`,
    invalidValue: (name) => `The value given for ${name} is not text.`,
    lockedByEnvironment: (name) =>
      `${name} comes from this machine's environment (shell, Docker, CI), so it cannot be changed from here — a value typed in would never be used. Change it where it is defined, then restart the analysis service.`,
    writeFailed: (detail) => `The key could not be saved: ${detail}`,
  },

  api: {
    targetMissing:
      'Tell us what to analyze: a folder, a file, or a GitHub repository URL.',
    unknownMode: 'That kind of analysis does not exist.',
    estimateExpired:
      'Your estimate has expired. Run it again: the project may have changed since.',
    scanStarted: 'Analysis started. You can follow it live.',
    estimateFailed: 'We could not work out how much work this project needs.',
    targetUnreadable: 'We could not read what you asked us to analyze.',
  },

  scanner: {
    noAttackSurface: (route) =>
      `The ${route} route takes no resource number in its address: there is nothing a visitor could change to reach somebody else's data.`,
    userScoped: (route) =>
      `On the ${route} route, every database read checks that the data belongs to the signed-in person. Changing the number in the address gives access to nothing.`,
    unscopedNoGuard: (route) =>
      `The ${route} route fetches data from a number supplied in the address, without checking who it belongs to and without any declared access control. This is the classic data-leak pattern.`,
    needsReview: (route) =>
      `The ${route} route needs a closer look: the first automatic pass could not settle it alone.`,
  },

  aggregator: {
    nothingReported: 'The detectors reported no security issue on this scan.',
    received: (total, retained) =>
      `${total} report(s) received from the detectors, ${retained} kept after cleanup.`,
    excludedNonProduction: (count) =>
      `${count} concerned test or demo files rather than code that actually runs online: dropped.`,
    mergedDuplicates: (count) =>
      `${count} duplicated an identical report and were merged together.`,
    rejectedLowConfidence: (count) =>
      `${count} turned out to be harmless on inspection and do not appear in the report.`,
    criticalCount: (count) =>
      `${count} point(s) need your attention first: those are the ones that expose the most data if somebody exploits them.`,
    noCritical: 'Nothing critical: the items kept are of moderate severity.',
    multipleAtSameLocation: (location, count, names) =>
      `On ${location}, ${count} different problems were spotted in the same place in the code (${names}). Each is fixed separately: solving one does not solve the other.`,
    and: ' and ',
  },

  report: {
    allClear: 'Good news: nothing worth flagging was found in your code on this scan.',
    foundWithCritical: (total, critical) =>
      `We found ${total} point${plural(total, '', 's')} worth your attention in your code, ${critical} of which deserve${plural(critical, 's', '')} a quick fix.`,
    foundNonUrgent: (total) =>
      `We found ${total} point${plural(total, '', 's')} worth your attention in your code. Nothing urgent, but worth a look.`,
    dismissed: (count) =>
      `${count} other report${plural(count, '', 's')} ${plural(count, 'was', 'were')} examined and then dismissed: on review, ${plural(count, 'it is a false alarm', 'they are false alarms')}.`,
    notArbitrated: (count) =>
      `Careful: ${count} point${plural(count, '', 's')} could not be double-checked by the second review. ${plural(count, 'It is', 'They are')} shown as-is, and should be confirmed by a person.`,
    routesFailed: (count) =>
      `${count} address${plural(count, '', 'es')} in your application could not be analyzed: this scan is incomplete.`,
    coverage: (routes) =>
      `${routes} address${plural(routes, '', 'es')} in your application ${plural(routes, 'was', 'were')} checked.`,
    suspected: (vulnerability, method, route, score) =>
      `${vulnerability} suspected on ${method} ${route} (detector score: ${score}).`,
    patchesDescribedInWords:
      'Fixes are described in words, not in code: a patch applied without review is a risk in itself.',
    patchStripped: (field) =>
      `The fix has to be decided and written by a developer: this field (${field}) contained a code snippet, deliberately removed because a patch applied without review is a risk in itself.`,
  },

  context: {
    routeUnknown:
      'We could not find the code for this address. It was not analyzed — do not assume it is safe.',
    listFailed: 'We could not list the project routes. Did indexing actually run?',
    refused: 'The context server refused the request.',
  },

  prompt: {
    answerLanguage:
      'Write every human-readable field (plain_language_summary in particular) in clear English, aimed at somebody who does not write code.',
  },
};


const CATALOG: Record<Locale, Messages> = { en: EN };

/** Messages de la langue demandée. */
export function messages(locale: Locale): Messages {
  return CATALOG[locale];
}
