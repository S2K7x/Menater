/**
 * Règles heuristiques de sévérité et d'exclusion.
 *
 * Fichier séparé de la logique de routing, comme demandé par PHASE_4 :
 * ces règles sont faites pour être ajustées souvent, le routing non.
 *
 * ============================================================================
 * DÉCISION DE MODÉLISATION : SÉVÉRITÉ ≠ CONFIANCE
 *
 * La spec parle de « scoring de sévérité » et de « +1 / -1 niveau » sans
 * jamais définir l'échelle ni dire d'où part le niveau de base. Le combler
 * oblige à trancher, et le piège serait de dériver la sévérité du
 * `confidence_score` — ce sont deux axes indépendants :
 *
 *   confidence_score = « suis-je sûr que c'est vrai ? »   (certitude)
 *   severity         = « si c'est vrai, c'est grave ? »   (impact)
 *
 * Un IDOR certain à 0.95 sur une route de préférences d'affichage est moins
 * urgent qu'un IDOR à 0.5 sur /admin/users/:id. Les mélanger produirait un
 * tri qui remonte les certitudes anodines avant les doutes graves.
 *
 * La sévérité part donc de la CLASSE de vulnérabilité, puis les règles de
 * route l'ajustent. Le `confidence_score` ne sert qu'au routing et au tri
 * secondaire.
 * ============================================================================
 */

export const SEVERITY_LEVELS = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

/** Impact de base par classe de vulnérabilité, si l'exploitation réussit. */
const BASE_SEVERITY: Record<string, Severity> = {
  SQLI: 'critical',
  IDOR: 'high',
  XSS: 'medium',
  SECURITY_MISCONFIGURATION: 'medium',
  SSRF: 'high',
};

/** Sévérité par défaut d'une classe inconnue : jamais en dessous de medium. */
const UNKNOWN_VULNERABILITY_SEVERITY: Severity = 'medium';

export function baseSeverityFor(vulnerability: string): Severity {
  return BASE_SEVERITY[vulnerability.toUpperCase()] ?? UNKNOWN_VULNERABILITY_SEVERITY;
}

export function shiftSeverity(severity: Severity, steps: number): Severity {
  const index = SEVERITY_LEVELS.indexOf(severity);
  const next = Math.min(Math.max(index + steps, 0), SEVERITY_LEVELS.length - 1);
  return SEVERITY_LEVELS[next]!;
}

export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_LEVELS.indexOf(b) - SEVERITY_LEVELS.indexOf(a);
}

// ---------------------------------------------------------------------------
// Règles d'ajustement liées à la route
// ---------------------------------------------------------------------------

export interface SeverityAdjustment {
  steps: number;
  /** Formulation destinée au rapport final : lisible par un non-développeur. */
  reason: string;
}

/**
 * Comparaison par SEGMENT de chemin, pas par sous-chaîne.
 *
 * Bug trouvé par la mesure de bout en bout : `/orders/public/:id` n'était pas
 * reconnue comme publique, parce que la règle testait `route.startsWith('/public')`.
 * Le segment « public » au milieu du chemin est pourtant le cas le plus
 * courant (`/orders/public/:id`, `/api/v1/public/docs`). Symétriquement,
 * `includes('/admin')` matcherait `/badminton` — les deux erreurs se corrigent
 * en découpant le chemin.
 */
function hasSegment(route: string, names: string[]): boolean {
  const segments = route.toLowerCase().split('/').filter(Boolean);
  return names.some((name) => segments.includes(name.replace(/^\//, '')));
}

/** Segments de route qui trahissent une zone d'administration ou interne. */
const PRIVILEGED_SEGMENTS = ['/admin', '/internal', '/manage', '/backoffice', '/superuser'];

/**
 * Segments qui trahissent des données financières ou personnelles.
 * La spec les mentionne sans les énumérer ; on les rend explicites pour
 * pouvoir les ajuster sans relire la logique.
 */
const SENSITIVE_DATA_SEGMENTS = [
  '/payment',
  '/payments',
  '/invoice',
  '/invoices',
  '/billing',
  '/card',
  '/bank',
  '/salary',
  '/payroll',
  '/ssn',
  '/medical',
  '/health-record',
  '/patient',
  '/identity',
  '/passport',
];

/** Segments explicitement publics par conception. */
const PUBLIC_SEGMENTS = ['/public', '/health', '/healthz', '/ping', '/status', '/metrics'];

/** Décorateurs marquant une route comme volontairement publique. */
const PUBLIC_DECORATORS = ['@Public', '@AllowAnonymous', '@SkipAuth', '@NoAuth'];

export interface RouteContext {
  route: string;
  decorators: string[];
}

/** Calcule tous les ajustements applicables à une route. */
export function severityAdjustmentsFor(context: RouteContext): SeverityAdjustment[] {
  const adjustments: SeverityAdjustment[] = [];
  const route = context.route.toLowerCase();

  if (hasSegment(route, PRIVILEGED_SEGMENTS)) {
    adjustments.push({
      steps: +1,
      reason:
        "Cette adresse fait partie de l'espace d'administration : ce qui fuit ici concerne tout le monde, pas un seul compte.",
    });
  }

  if (hasSegment(route, SENSITIVE_DATA_SEGMENTS)) {
    adjustments.push({
      steps: +1,
      reason:
        'Cette adresse manipule des données financières ou personnelles : une fuite y est bien plus dommageable.',
    });
  }

  const isPublicByDecorator = context.decorators.some((decorator) =>
    PUBLIC_DECORATORS.some((marker) => decorator.startsWith(marker))
  );
  const isPublicByPath = hasSegment(route, PUBLIC_SEGMENTS);

  if (isPublicByDecorator || isPublicByPath) {
    adjustments.push({
      steps: -1,
      reason: 'Cette adresse est volontairement publique : son contenu est censé être visible de tous.',
    });
  }

  return adjustments;
}

/** Applique les ajustements et renvoie le niveau final + le détail. */
export function computeSeverity(
  vulnerability: string,
  context: RouteContext
): { severity: Severity; base: Severity; adjustments: SeverityAdjustment[] } {
  const base = baseSeverityFor(vulnerability);
  const adjustments = severityAdjustmentsFor(context);
  const totalSteps = adjustments.reduce((sum, adjustment) => sum + adjustment.steps, 0);
  return { severity: shiftSeverity(base, totalSteps), base, adjustments };
}

// ---------------------------------------------------------------------------
// Exclusion des faux positifs évidents
// ---------------------------------------------------------------------------

/**
 * Chemins qui ne sont pas du code de production.
 *
 * ÉLARGI PAR RAPPORT À LA SPEC, qui liste seulement `*.test.ts`, `*.spec.ts`,
 * `mock/` et `fixtures/`. Cette liste laisse passer les conventions les plus
 * répandues — `__tests__/`, `__mocks__/`, `__fixtures__/` — au point que les
 * fixtures de CE dépôt (`src/nodes/idor/__fixtures__/`) n'auraient PAS été
 * filtrées : le scan de VulnPipe par lui-même remonterait ses propres cas de
 * test comme vulnérabilités.
 */
const NON_PRODUCTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\.(test|spec)\.[cm]?[jt]sx?$/i, label: 'fichier de test' },
  { pattern: /(^|\/)__tests__\//i, label: 'dossier de tests' },
  { pattern: /(^|\/)__mocks__\//i, label: 'dossier de doublures' },
  { pattern: /(^|\/)__fixtures__\//i, label: 'dossier de fixtures' },
  { pattern: /(^|\/)mocks?\//i, label: 'dossier de doublures' },
  { pattern: /(^|\/)fixtures?\//i, label: 'dossier de fixtures' },
  { pattern: /(^|\/)tests?\//i, label: 'dossier de tests' },
  { pattern: /(^|\/)e2e\//i, label: 'dossier de tests bout en bout' },
  { pattern: /\.stories\.[cm]?[jt]sx?$/i, label: 'fichier de démonstration de composant' },
];

export interface ExclusionVerdict {
  excluded: boolean;
  /** Motif lisible, conservé dans les stats : on ne jette jamais en silence. */
  reason: string | null;
}

/**
 * Décide si un fichier doit être écarté.
 *
 * Le résultat est TRACÉ, jamais silencieux : écarter par chemin est une
 * décision de sécurité, et un fichier rangé dans `fixtures/` mais réellement
 * servi en production produirait un faux négatif invisible.
 */
export function classifySourcePath(file: string): ExclusionVerdict {
  const normalized = file.replace(/\\/g, '/');
  for (const { pattern, label } of NON_PRODUCTION_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        excluded: true,
        reason: `Écarté : ${normalized} est un ${label}, pas du code exécuté en production.`,
      };
    }
  }
  return { excluded: false, reason: null };
}
