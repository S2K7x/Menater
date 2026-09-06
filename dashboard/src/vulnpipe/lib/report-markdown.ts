/**
 * Le rapport, en Markdown, pour sortir de l'écran.
 *
 * ============================================================================
 * POURQUOI
 *
 * Point 4 de la file d'attente du `ROADMAP.md`. Jusqu'ici, RIEN ne sortait de
 * l'interface : pas moyen de garder une trace d'un scan, de le joindre à un
 * ticket, ni de le montrer à quelqu'un de plus expérimenté. Or c'est
 * exactement ce que fait une personne qui ne sait pas corriger seule — elle
 * demande de l'aide, et elle a besoin d'un document à transmettre.
 *
 * Markdown, et pas PDF ni HTML : c'est lisible tel quel dans un éditeur de
 * texte, ça se colle dans un ticket, un message, ou un assistant IA, et ça ne
 * demande aucune dépendance.
 *
 * TROIS RÈGLES TENUES ICI
 *
 *  1. **Le langage simple d'abord.** Même ordre qu'à l'écran : ce que la
 *     personne risque, puis quoi faire, et seulement ensuite le détail
 *     technique. Un export qui remonte le jargon en tête annulerait tout le
 *     travail d'explicabilité de `CLAUDE.md` §4.
 *
 *  2. **Les alertes écartées restent comptées.** Elles ne sont pas dans le
 *     corps du rapport, mais leur nombre est dit. Un document qui les passe
 *     sous silence laisserait croire que rien n'a été rejeté.
 *
 *  3. **Aucun chemin absolu.** Le rapport est fait pour être PARTAGÉ.
 *     `source_root` (`/Users/prenom/...`) est délibérément absent : il révèle
 *     le nom de la personne et l'arborescence de sa machine, sans rien
 *     apporter à qui lit.
 * ============================================================================
 */

import type { Locale } from '../../i18n/dictionary.ts';
import type { ReportFinding, SecurityReport } from '../components/ReportView.tsx';

export interface ReportMeta {
  /** Libellé de la cible analysée, tel qu'affiché à l'écran. */
  targetLabel?: string | null;
  /** Date de génération. Injectable pour que les tests soient déterministes. */
  generatedAt?: Date;
}

/**
 * Libellés du document exporté.
 *
 * Typés explicitement plutôt qu'en `as const` : sans ce type, TypeScript déduit
 * de chaque langue un type littéral distinct, et les deux catalogues cessent
 * d'être interchangeables. Le type sert aussi de garde-fou — ajouter une clé
 * dans une langue et l'oublier dans l'autre ne compile pas.
 */
interface ExportStrings {
  title: string;
  generated: (date: string) => string;
  project: string;
  summary: string;
  critical: string;
  warning: string;
  dismissedCount: (n: number) => string;
  nothing: string;
  whatToDo: string;
  where: string;
  line: string;
  code: string;
  technical: string;
  problemType: string;
  analysis: string;
  whyVerdict: string;
  reference: string;
  unchecked: string;
  footer: string;
}

const TEMPLATES: Record<Locale, ExportStrings> = {
  en: {
    title: 'Security report',
    generated: (date: string) => `Scan of ${date}`,
    project: 'Project scanned',
    summary: 'In short',
    critical: 'to fix quickly',
    warning: 'to keep an eye on',
    dismissedCount: (n: number) => `${n} false alarm(s) dropped by the review`,
    nothing: 'No issue was retained in this scan.',
    whatToDo: 'What to do',
    where: 'Where',
    line: 'line',
    code: 'Relevant code',
    technical: 'Technical detail',
    problemType: 'Type of problem',
    analysis: 'Analysis',
    whyVerdict: 'Why this verdict',
    reference: 'Reference category',
    unchecked: '⚠️ This point could not be double-checked by the second review: have it confirmed.',
    footer:
      'Report produced by VulnPipe. The explanations are written to be understood without being a developer; the technical detail is there for whoever fixes it.',
  },
};

/**
 * Clôture de bloc de code plus longue que la plus longue suite d'accents
 * graves du contenu.
 *
 * Sans ça, un fichier analysé contenant ``` (un README, une chaîne de
 * caractères) refermerait le bloc en plein milieu, et la suite du rapport
 * s'afficherait comme du code. Le contenu vient d'un dépôt inconnu : on ne
 * suppose rien de ce qu'il contient.
 */
export function fenceFor(content: string): string {
  const longest = (content.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function severityWord(finding: ReportFinding, t: ExportStrings): string {
  return finding.report_level === 'critical' ? t.critical : t.warning;
}

function renderFinding(finding: ReportFinding, t: ExportStrings): string[] {
  const lines: string[] = [];

  lines.push(`## ${finding.http_method} ${finding.route} — ${severityWord(finding, t)}`, '');
  lines.push(finding.plain_language_summary, '');
  lines.push(`**${t.whatToDo}** : ${finding.suggested_fix_direction}`, '');

  if (finding.claude_verdict !== 'confirmed' || finding.evidence !== 'code') {
    lines.push(t.unchecked, '');
  }

  const where =
    finding.line !== null ? `${finding.file} (${t.line} ${finding.line})` : finding.file;
  lines.push(`**${t.where}** : ${where}`, '');

  if (finding.code_excerpt) {
    const body = finding.code_excerpt.lines
      .map((line, offset) => {
        const number = finding.code_excerpt!.start_line + offset;
        const marker = number === finding.code_excerpt!.highlight_line ? '>' : ' ';
        return `${marker} ${String(number).padStart(4)} | ${line}`;
      })
      .join('\n');
    const fence = fenceFor(body);
    lines.push(`**${t.code}**`, '', fence, body, fence, '');
  }

  lines.push(`<details>`, `<summary>${t.technical}</summary>`, '');
  lines.push(`- **${t.problemType}** : ${finding.vulnerability}`);
  lines.push(`- **${t.analysis}** : ${finding.technical_summary}`);
  lines.push(`- **${t.whyVerdict}** : ${finding.claude_reasoning}`);
  lines.push(`- **${t.reference}** : ${finding.owasp_category}`);
  lines.push('', `</details>`, '');

  return lines;
}

/** Rend le rapport complet en Markdown. */
export function reportToMarkdown(
  report: SecurityReport,
  locale: Locale,
  meta: ReportMeta = {}
): string {
  const t = TEMPLATES[locale] ?? TEMPLATES.en;
  const summary = report.scan_summary;
  const date = (meta.generatedAt ?? new Date()).toLocaleDateString(
    'en-GB',
    { year: 'numeric', month: 'long', day: 'numeric' }
  );

  const lines: string[] = [`# ${t.title}`, '', t.generated(date)];

  // Le libellé de la cible est celui de l'écran (« projet/api »), jamais un
  // chemin absolu : voir l'en-tête de ce fichier.
  if (meta.targetLabel) lines.push('', `**${t.project}** : ${meta.targetLabel}`);

  lines.push('', `## ${t.summary}`, '', summary.plain_language_intro, '');
  lines.push(`- **${summary.critical}** ${t.critical}`);
  lines.push(`- **${summary.warning}** ${t.warning}`);
  if (summary.dismissed_by_arbiter > 0) {
    lines.push(`- ${t.dismissedCount(summary.dismissed_by_arbiter)}`);
  }
  lines.push('');

  if (report.findings.length === 0) {
    lines.push(t.nothing, '');
  } else {
    for (const finding of report.findings) lines.push(...renderFinding(finding, t));
  }

  lines.push('---', '', `_${t.footer}_`, '');
  return lines.join('\n');
}

/** Nom de fichier proposé au téléchargement. Sans espace ni accent. */
export function reportFileName(meta: ReportMeta = {}): string {
  const date = (meta.generatedAt ?? new Date()).toISOString().slice(0, 10);
  const slug = (meta.targetLabel ?? 'scan')
    .normalize('NFD')
    // Diacritiques (U+0300 à U+036F), écrits en échappement : la classe
    // littérale est invisible à la relecture et se perd au copier-coller.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
  return `vulnpipe-${slug || 'scan'}-${date}.md`;
}
