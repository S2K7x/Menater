/**
 * Affichage du rapport final — « Vibe Coder Mode ».
 *
 * Règles de PHASE_6 tenues ici :
 *  - par défaut, uniquement `plain_language_summary` + badge de gravité ;
 *  - le détail technique est REPLIÉ, derrière un bouton explicite ;
 *  - aucun terme technique n'apparaît seul : chaque nom de vulnérabilité est
 *    accompagné de sa traduction (info-bulle + texte visible).
 */

import { useState } from 'react';

import { explainTerm, severityLabel } from '../lib/step_translations.ts';
import { useI18n } from '../../i18n/context.tsx';
import { usePreferences } from '../lib/preferences.ts';
import { buildFixPrompt } from '../lib/fix-prompt.ts';
import { reportFileName, reportToMarkdown, type ReportMeta } from '../lib/report-markdown.ts';
import { FindingStatusControl, StaleStatusNotice, useStatuses } from './FindingStatus.tsx';
import { findingKey, statusStats } from '../lib/finding-status.ts';
import { Fold } from '../../components/Guidance.tsx';
import { Icon } from './Icon.tsx';

export interface ReportFinding {
  severity: string;
  report_level: 'critical' | 'warning';
  vulnerability: string;
  route: string;
  http_method: string;
  file: string;
  line: number | null;
  claude_verdict: 'confirmed' | 'rejected' | 'needs_human_review';
  claude_reasoning: string;
  technical_summary: string;
  plain_language_summary: string;
  suggested_fix_direction: string;
  owasp_category: string;
  evidence: 'code' | 'summary_only' | 'not_arbitrated';
  local_confidence_score: number;
  detected_by: string[];
  code_excerpt: CodeExcerpt | null;
}

export interface CodeExcerpt {
  start_line: number;
  lines: string[];
  highlight_line: number;
  truncated: boolean;
}

export interface SecurityReport {
  scan_summary: {
    total_findings: number;
    critical: number;
    warning: number;
    dismissed_by_arbiter: number;
    not_arbitrated: number;
    plain_language_intro: string;
  };
  findings: ReportFinding[];
  dismissed: Array<{ vulnerability: string; route: string; http_method: string }>;
  /**
   * Racine absolue du code analysé, ou `null` quand elle n'existe plus après le
   * scan (dépôt GitHub cloné puis supprimé). Sans elle, pas de lien vers
   * l'éditeur : mieux vaut aucun lien qu'un lien mort.
   */
  source_root: string | null;
}

/** Nom technique + sa traduction, jamais l'un sans l'autre. */
export function VulnerabilityName({ name }: { name: string }) {
  const { locale, t } = useI18n();
  const explanation = explainTerm(name, locale);
  if (!explanation) {
    // Terme absent du glossaire : on n'affiche PAS un sigle nu à quelqu'un qui
    // ne code pas. Mieux vaut une formulation générique qu'un mot opaque.
    return <span className="vp-vuln-name">{t.report.securityIssue}</span>;
  }
  return (
    <span className="vp-vuln-name" title={explanation}>
      <abbr title={explanation}>{name}</abbr>
      <span className="vp-vuln-gloss"> — {explanation}</span>
    </span>
  );
}

function SeverityBadge({ severity }: { severity: string }) {
  const { locale } = useI18n();
  const entry = severityLabel(severity, locale);
  return (
    <span className={`vp-badge vp-badge-${entry.tone}`} title={entry.explanation}>
      {entry.label}
    </span>
  );
}

/** Bandeau affiché quand un point n'a pas pu être revérifié. */
function VerdictNotice({ finding }: { finding: ReportFinding }) {
  const { t } = useI18n();
  if (finding.claude_verdict === 'confirmed' && finding.evidence === 'code') return null;

  const message =
    finding.evidence === 'not_arbitrated'
      ? t.report.noticeNotArbitrated
      : finding.claude_verdict === 'needs_human_review'
        ? t.report.noticeNeedsHuman
        : t.report.noticeSummaryOnly;

  return (
    <p className="vp-notice" role="note">
      <Icon name="warning" size={16} />
      {message}
    </p>
  );
}

/**
 * Le code en cause, ligne fautive surlignée.
 *
 * Le contenu vient du dépôt analysé : donnée non fiable. Il est rendu comme du
 * TEXTE (React échappe), jamais interprété — pas de `dangerouslySetInnerHTML`
 * ici, sous aucun prétexte.
 */
export function CodeExcerptBlock({ excerpt }: { excerpt: CodeExcerpt | null }) {
  const { t } = useI18n();
  if (!excerpt) return <p className="vp-code-missing">{t.report.codeUnavailable}</p>;

  return (
    <figure className="vp-code">
      <figcaption className="vp-code-caption">{t.report.codeHeading}</figcaption>
      <pre className="vp-code-pre">
        <code>
          {excerpt.lines.map((line, offset) => {
            const number = excerpt.start_line + offset;
            const faulty = number === excerpt.highlight_line;
            return (
              <span
                key={number}
                className={faulty ? 'vp-code-line vp-code-line-faulty' : 'vp-code-line'}
                data-testid={faulty ? 'code-line-faulty' : 'code-line'}
              >
                <span className="vp-code-number" aria-hidden="true">
                  {number}
                </span>
                <span className="vp-code-text">{line}</span>
              </span>
            );
          })}
        </code>
      </pre>
      {excerpt.truncated && <p className="vp-code-note">{t.report.codeTruncated}</p>}
    </figure>
  );
}

/**
 * Bouton « copier une demande de correction ».
 *
 * L'échec de copie est AFFICHÉ. Un bouton qui ne fait rien et n'explique rien
 * est le mode de défaillance le plus frustrant qui soit — et l'API
 * presse-papier échoue pour de vrai (page non sécurisée, permission refusée).
 */
export function CopyFixPromptButton({ finding }: { finding: ReportFinding }) {
  const { locale, t } = useI18n();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async (): Promise<void> => {
    const text = buildFixPrompt(finding, locale);
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
      window.setTimeout(() => setState('idle'), 2500);
    } catch {
      setState('failed');
    }
  };

  return (
    <div className="vp-fix-prompt">
      <button type="button" className="vp-action" onClick={copy} title={t.report.copyFixPromptHelp}>
        <Icon name="code" />
        {state === 'copied' ? t.report.copied : t.report.copyFixPrompt}
      </button>
      <span className="vp-field-help">{t.report.copyFixPromptHelp}</span>
      {state === 'failed' && (
        <p className="vp-code-note" role="alert">
          {t.report.copyFailed}
        </p>
      )}
    </div>
  );
}

/** Nom affichable de l'éditeur choisi dans les réglages. */
const EDITOR_LABELS: Record<string, string> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
};

/**
 * Lien « ouvrir dans mon éditeur ».
 *
 * Affiché UNIQUEMENT quand on a une racine absolue qui survit au scan et une
 * ligne. Pour un dépôt GitHub, le clone temporaire est supprimé à la fin du
 * scan : le lien pointerait dans le vide, on préfère ne rien afficher.
 */
export function OpenInEditorLink({
  finding,
  sourceRoot,
}: {
  finding: ReportFinding;
  sourceRoot: string | null;
}) {
  const { t } = useI18n();
  const { preferences } = usePreferences();
  if (sourceRoot === null || finding.line === null) return null;

  const path = `${sourceRoot.replace(/\/$/, '')}/${finding.file}`;
  const label = EDITOR_LABELS[preferences.editor] ?? preferences.editor;

  return (
    <a
      className="vp-action"
      href={`${preferences.editor}://file/${path}:${finding.line}`}
      title={t.report.openInEditorHelp}
    >
      <Icon name="file" />
      {t.report.openInEditor(label)}
    </a>
  );
}

export function FindingCard({
  finding,
  sourceRoot = null,
}: {
  finding: ReportFinding;
  sourceRoot?: string | null;
}) {
  const { locale, t } = useI18n();
  const { preferences } = usePreferences();
  // Replié par défaut : exigence explicite de la spec. La préférence peut
  // l'ouvrir d'emblée — c'est un choix que l'utilisateur pose lui-même dans
  // les réglages, pas un défaut qu'on lui impose.
  const [showTechnical, setShowTechnical] = useState(preferences.technicalByDefault);
  const statuses = useStatuses();
  const entry = statuses[findingKey(finding)];
  // Écartée = estompée, jamais retirée. Cacher un point qu'on a soi-même mis
  // de côté finirait par le faire oublier.
  const setAside = entry?.status === 'accepted' || entry?.status === 'false_positive';

  return (
    <article
      className={`vp-finding vp-level-${finding.report_level}${setAside ? ' vp-finding-aside' : ''}`}
    >
      <header className="vp-finding-head">
        <SeverityBadge severity={finding.severity} />
        <span className="vp-finding-route">
          {finding.http_method} {finding.route}
        </span>
      </header>

      {/* Ce que voit l'utilisateur non-technique, en premier et sans effort. */}
      <p className="vp-finding-plain">{finding.plain_language_summary}</p>

      <div className="vp-finding-fix">
        <strong>{t.report.whatToDo}</strong>
        {finding.suggested_fix_direction}
      </div>

      <VerdictNotice finding={finding} />
      <StaleStatusNotice finding={finding} />

      {/* Rendre la faille actionnable : voir le code, le donner à un assistant,
          ou aller le corriger. Avant, on affichait « ligne 3 » et rien d'autre. */}
      <CodeExcerptBlock excerpt={finding.code_excerpt} />

      <div className="vp-finding-actions">
        <CopyFixPromptButton finding={finding} />
        <OpenInEditorLink finding={finding} sourceRoot={sourceRoot} />
      </div>

      <FindingStatusControl finding={finding} />

      <button
        type="button"
        className="vp-toggle"
        onClick={() => setShowTechnical((open) => !open)}
        aria-expanded={showTechnical}
      >
        {showTechnical ? t.report.hideTechnical : t.report.showTechnical}
      </button>

      {showTechnical && (
        <div className="vp-finding-technical">
          <dl>
            <dt>{t.report.problemType}</dt>
            <dd>
              <VulnerabilityName name={finding.vulnerability} />
            </dd>

            <dt>{t.report.whereLabel}</dt>
            <dd>
              {finding.file}
              {finding.line !== null ? t.report.lineSuffix(finding.line) : ''}
            </dd>

            <dt>{t.report.analysis}</dt>
            <dd>{finding.technical_summary}</dd>

            <dt>{t.report.whyVerdict}</dt>
            <dd>{finding.claude_reasoning}</dd>

            <dt>
              {t.report.referenceCategory}{' '}
              <abbr title={explainTerm('OWASP', locale) ?? ''}>OWASP</abbr>
            </dt>
            <dd title={explainTerm(finding.owasp_category, locale) ?? undefined}>
              {finding.owasp_category}
            </dd>
          </dl>
        </div>
      )}
    </article>
  );
}

/**
 * Sortir le rapport de l'écran : copier en Markdown, ou télécharger.
 *
 * Point 4 de la file d'attente du `ROADMAP.md`. Deux gestes plutôt qu'un :
 * copier sert à coller dans une conversation ou un ticket, télécharger sert à
 * archiver. Ils ne se remplacent pas.
 *
 * Le téléchargement passe par une URL d'objet, révoquée juste après : sans
 * révocation, chaque export garderait le rapport en mémoire jusqu'au
 * rechargement de la page.
 */
export function ReportExport({ report, meta }: { report: SecurityReport; meta: ReportMeta }) {
  const { locale, t } = useI18n();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const markdown = (): string => reportToMarkdown(report, locale, meta);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(markdown());
      setState('copied');
      window.setTimeout(() => setState('idle'), 2500);
    } catch {
      setState('failed');
    }
  };

  const download = (): void => {
    const blob = new Blob([markdown()], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = reportFileName(meta);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="vp-report-export">
      <div className="vp-report-export-actions">
        <button type="button" className="vp-action" onClick={copy}>
          <Icon name="document" />
          {state === 'copied' ? t.report.reportCopied : t.report.copyReport}
        </button>
        <button type="button" className="vp-action" onClick={download}>
          <Icon name="file" />
          {t.report.downloadReport}
        </button>
      </div>
      <span className="vp-field-help">{t.report.exportHelp}</span>
      {state === 'failed' && (
        <p className="vp-code-note" role="alert">
          {t.report.copyFailed}
        </p>
      )}
    </div>
  );
}

/**
 * Où en est la personne : ce qui reste, ce qui est corrigé, ce qu'elle a écarté.
 *
 * Le taux affiché EXCLUT les points écartés, des deux côtés de la fraction.
 * C'est la règle posée dans le ROADMAP avant d'écrire ce code : un outil dont
 * le score monte quand on écarte des alertes apprend à écarter des alertes.
 */
export function StatusSummary({ findings }: { findings: ReportFinding[] }) {
  const { t } = useI18n();
  const store = useStatuses();
  const stats = statusStats(findings, store);
  const dismissed = stats.accepted + stats.falsePositive;

  if (findings.length === 0) return null;

  return (
    <div className="vp-status-summary">
      <span className="vp-kicker">{t.status.summaryHeading}</span>
      <p className="vp-status-rate">
        {stats.fixRate === null
          ? t.status.nothingToTreat
          : t.status.fixRate(Math.round(stats.fixRate * 100))}
      </p>
      {dismissed > 0 && (
        <>
          <p className="vp-field-help">{t.status.dismissedCount(dismissed)}</p>
          <p className="vp-field-help">{t.status.excludedNote}</p>
        </>
      )}
    </div>
  );
}

/**
 * Ce que le scan a REELLEMENT couvert.
 *
 * Tout est nullable, et rien n'est comble : un scan qui n'a pas dit combien
 * d'adresses il a lues ne se voit pas attribuer un chiffre plausible. C'est la
 * regle du produit — une donnee manquante se montre comme manquante — et elle
 * compte doublement ici, ou le chiffre sert a qualifier un VIDE.
 */
export interface ScanCoverage {
  mode: 'full_scan' | 'incremental_scan' | null;
  filesIndexed: number | null;
  routesFound: number | null;
  routesAnalyzed: number | null;
  routesFailed: number | null;
}

/**
 * L'ecran « aucune faille trouvee », ecrit plutot que laisse vide.
 *
 * ============================================================================
 * CE QU'UNE PHRASE UNIQUE CONFONDAIT
 *
 * « Rien a signaler sur ce scan » etait affiche a l'identique dans trois
 * situations qui ne se valent pas :
 *
 *   1. tout a ete lu, rien trouve                  — un resultat ;
 *   2. des adresses n'ont PAS pu etre analysees    — un resultat partiel, et
 *                                                    la phrase couvrait le
 *                                                    trou au lieu de le dire ;
 *   3. seul ce qui a change a ete relu             — une phrase qui ne dit
 *                                                    rien du reste du projet,
 *                                                    et qu'on lit comme si.
 *
 * Le cas 2 est la faute grave, et c'est exactement celle que l'onglet Lookup
 * refuse dans les memes termes : « clean » exige une source qui a REPONDU.
 * Une couverture partielle change donc le TITRE, pas seulement une note en
 * bas — parce qu'un titre rassurant est ce qu'on retient.
 *
 * Et quand la couverture est inconnue, l'ecran le dit au lieu de choisir le
 * titre flatteur : un vide non qualifie reste un vide non qualifie.
 * ============================================================================
 */
export function NothingFound({
  coverage = null,
  dismissed = [],
  dismissedCount = 0,
}: {
  coverage?: ScanCoverage | null;
  dismissed?: SecurityReport['dismissed'];
  dismissedCount?: number;
}) {
  const { t } = useI18n();
  const n = t.report.nothing;

  // Sans le nombre d'adresses lues, il n'y a rien a qualifier : on ne fabrique
  // pas une couverture pour pouvoir afficher un titre.
  const known = coverage !== null && coverage.routesAnalyzed !== null;
  const failed = coverage?.routesFailed ?? 0;
  const incremental = coverage?.mode === 'incremental_scan';
  const partial = known && (failed > 0 || incremental);

  const facts: string[] = [];
  if (coverage?.filesIndexed !== null && coverage?.filesIndexed !== undefined) {
    facts.push(n.files(coverage.filesIndexed));
  }
  if (coverage?.routesFound !== null && coverage?.routesFound !== undefined) {
    facts.push(n.routesFound(coverage.routesFound));
  }
  if (coverage?.routesAnalyzed !== null && coverage?.routesAnalyzed !== undefined) {
    facts.push(n.routesAnalyzed(coverage.routesAnalyzed));
  }
  if (coverage?.mode) facts.push(incremental ? n.modeIncremental : n.modeFull);

  /*
    Trois tons, pas deux. Le vert est le TON DE LA CERTITUDE : il ne se prend
    que quand on sait que tout a ete lu. Une couverture partielle est orange —
    elle nomme un trou. Une couverture INCONNUE n'est ni l'un ni l'autre : la
    premiere version prenait le vert par defaut, c'est-a-dire qu'elle
    rassurait sur un scan dont elle ignorait tout. C'est precisement le defaut
    que cet ecran existe pour supprimer, reproduit dans l'ecran lui-meme.
  */
  const tone = !known ? 'unknown' : partial ? 'partial' : 'clear';
  const icon = tone === 'clear' ? 'check' : tone === 'partial' ? 'warning' : 'shield-question';

  return (
    <section className={`vp-nothing vp-nothing-${tone}`}>
      <h3>
        <Icon name={icon} size={18} />
        {tone === 'clear' ? n.titleClear : tone === 'partial' ? n.titlePartial : n.titleUnknown}
      </h3>
      <p className="vp-nothing-lede">{known ? n.lede : n.unknown}</p>

      {facts.length > 0 && (
        <>
          <span className="vp-kicker">{n.scope}</span>
          <ul className="vp-nothing-facts">
            {facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </>
      )}

      {/* Les reserves, une par cause, chacune disant ce qu'elle retire a la
          phrase du dessus. Elles ne se replient pas : ce sont des constats. */}
      {failed > 0 && (
        <p className="vp-nothing-caveat" role="note">
          <Icon name="warning" size={15} />
          <span>
            <strong>{n.failed(failed)}</strong> {n.caveatFailed}
          </span>
        </p>
      )}
      {incremental && (
        <p className="vp-nothing-caveat" role="note">
          <Icon name="warning" size={15} />
          <span>
            <strong>{n.modeIncremental}</strong> {n.caveatIncremental}
          </span>
        </p>
      )}

      {/*
        Les fausses alertes ecartees expliquent POURQUOI l'ecran est vide : le
        moteur a bien trouve quelque chose, et la seconde relecture l'a rejete.
        Sans elles, un vide se lit comme « il n'a rien cherche ».
      */}
      {dismissedCount > 0 && (
        <div className="vp-nothing-dismissed">
          <p>{n.dismissed(dismissedCount)}</p>
          {dismissed.length > 0 && (
            <Fold title={n.dismissedFold} hint={String(dismissed.length)}>
              <ul className="vp-nothing-facts">
                {dismissed.map((d, i) => (
                  <li key={`${d.http_method}-${d.route}-${i}`}>
                    <code>
                      {d.http_method} {d.route}
                    </code>{' '}
                    — <VulnerabilityName name={d.vulnerability} />
                  </li>
                ))}
              </ul>
            </Fold>
          )}
        </div>
      )}
    </section>
  );
}

export function ReportView({
  report,
  target = null,
  coverage = null,
}: {
  report: SecurityReport;
  /** Cible analysée, pour l'en-tête du rapport exporté. */
  target?: { label: string } | null;
  /** Ce que le scan a couvert. Absent = la couverture n'est pas qualifiable. */
  coverage?: ScanCoverage | null;
}) {
  const { t } = useI18n();
  const { scan_summary: summary, findings } = report;
  // Une adresse non lue n'est pas une adresse propre. Le constat vaut aussi
  // quand le rapport N'EST PAS vide : il borne ce que le rapport couvre.
  const notRead = coverage?.routesFailed ?? 0;

  return (
    <section className="vp-report">
      {/* Le verdict global, avant tout scroll. */}
      <header className="vp-report-header">
        <h2>{t.report.heading}</h2>
        <p className="vp-intro">{summary.plain_language_intro}</p>
        <ul className="vp-counters">
          <li className="vp-badge vp-badge-red">{t.report.countCritical(summary.critical)}</li>
          <li className="vp-badge vp-badge-orange">{t.report.countWarning(summary.warning)}</li>
          {summary.dismissed_by_arbiter > 0 && (
            <li className="vp-badge vp-badge-grey">
              {t.report.countDismissed(summary.dismissed_by_arbiter)}
            </li>
          )}
        </ul>
        {notRead > 0 && findings.length > 0 && (
          <p className="vp-notice" role="note">
            <Icon name="warning" size={16} />
            <span>
              <strong>{t.report.nothing.failed(notRead)}</strong>{' '}
              {t.report.nothing.caveatFailed}
            </span>
          </p>
        )}
        <StatusSummary findings={report.findings} />
        <ReportExport report={report} meta={{ targetLabel: target?.label ?? null }} />
      </header>

      {findings.length === 0 ? (
        <NothingFound
          coverage={coverage}
          dismissed={report.dismissed}
          dismissedCount={summary.dismissed_by_arbiter}
        />
      ) : (
        findings.map((finding) => (
          <FindingCard
            key={`${finding.vulnerability}-${finding.http_method}-${finding.route}`}
            finding={finding}
            sourceRoot={report.source_root}
          />
        ))
      )}
    </section>
  );
}
