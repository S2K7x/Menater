import { describe, it, expect } from 'vitest';

import {
  aggregate,
  fromNodeVerdict,
  DIRECT_ALERT_ABOVE,
  REJECT_BELOW,
  type NodeFinding,
} from './aggregator.ts';
import {
  baseSeverityFor,
  classifySourcePath,
  computeSeverity,
  shiftSeverity,
} from './severity-rules.ts';

/** Fabrique un finding avec des valeurs par défaut plausibles. */
function finding(overrides: Partial<NodeFinding> = {}): NodeFinding {
  return {
    vulnerability: 'IDOR',
    route: '/orders/:id',
    http_method: 'GET',
    handler: 'getOrder',
    file: 'src/orders/order.controller.ts',
    line: 12,
    confidence_score: 0.9,
    reason: null,
    plain_language_summary:
      "N'importe qui peut lire les commandes des autres en changeant le numéro dans l'adresse.",
    decorators: [],
    detected_by: 'idor-node',
    ...overrides,
  };
}

/**
 * Le jeu de 10 findings imposé par PHASE_4, couvrant tous les cas demandés.
 */
const TEN_FINDINGS: NodeFinding[] = [
  // 1 + 2 : DOUBLON — même vuln, même route, même ligne, deux nodes différents.
  finding({ detected_by: 'idor-node', confidence_score: 0.85 }),
  finding({ detected_by: 'idor-node-v2', confidence_score: 0.92 }),

  // 3 : fichier de test -> doit être exclu
  finding({
    route: '/orders/:id',
    file: 'src/orders/order.test.ts',
    confidence_score: 0.95,
    detected_by: 'idor-node',
  }),

  // 4 : route /admin avec score 0.6 -> sévérité remontée
  finding({
    route: '/admin/users/:id',
    handler: 'getUser',
    file: 'src/admin/admin.controller.ts',
    line: 22,
    confidence_score: 0.6,
    reason: 'ambiguous_logic',
    detected_by: 'idor-node',
    plain_language_summary:
      "Un compte sans droits d'administration pourrait lire les informations d'autres utilisateurs.",
  }),

  // 5 : zone grise sur route ordinaire
  finding({
    route: '/carts/:id',
    handler: 'getCart',
    file: 'src/carts/cart.controller.ts',
    line: 8,
    confidence_score: 0.55,
    reason: 'missing_context',
    detected_by: 'idor-node',
  }),

  // 6 : rejeté (< 0.4)
  finding({
    route: '/preferences/:id',
    handler: 'getPreferences',
    file: 'src/prefs/pref.controller.ts',
    line: 5,
    confidence_score: 0.15,
    detected_by: 'idor-node',
  }),

  // 7 : rejeté, juste sous le seuil
  finding({
    route: '/tags/:id',
    handler: 'getTag',
    file: 'src/tags/tag.controller.ts',
    line: 9,
    confidence_score: 0.39,
    detected_by: 'idor-node',
  }),

  // 8 : haute confiance sur route publique -> sévérité abaissée
  finding({
    route: '/public/articles/:id',
    handler: 'getArticle',
    file: 'src/articles/article.controller.ts',
    line: 14,
    confidence_score: 0.88,
    detected_by: 'idor-node',
  }),

  // 9 : SQLi critique sur route financière -> sévérité maximale
  finding({
    vulnerability: 'SQLI',
    route: '/billing/invoices/:id',
    handler: 'searchInvoices',
    file: 'src/billing/billing.controller.ts',
    line: 31,
    confidence_score: 0.93,
    detected_by: 'sqli-node',
    plain_language_summary:
      'Un visiteur peut faire exécuter ses propres commandes à la base de données de facturation.',
  }),

  // 10 : XSS AU MÊME ENDROIT que le SQLi -> corrélation, PAS fusion.
  finding({
    vulnerability: 'XSS',
    route: '/billing/invoices/:id',
    handler: 'searchInvoices',
    file: 'src/billing/billing.controller.ts',
    line: 31,
    confidence_score: 0.45,
    reason: 'ambiguous_logic',
    detected_by: 'xss-node',
    plain_language_summary:
      "Du texte fourni par un visiteur est réaffiché tel quel : il pourrait y glisser du code exécuté dans le navigateur d'un autre.",
  }),
];

describe('Cas de test imposé par PHASE_4 — jeu de 10 findings', () => {
  const result = aggregate(TEN_FINDINGS, { routesAnalyzed: 40 });

  it('fusionne les deux findings dupliqués en un seul, et le marque corroboré', () => {
    const orders = result.groups
      .flatMap((g) => g.vulnerabilities)
      .filter((v) => v.route === '/orders/:id');

    expect(orders).toHaveLength(1);
    expect(orders[0]!.detected_by.sort()).toEqual(['idor-node', 'idor-node-v2']);
    expect(orders[0]!.corroborated).toBe(true);
    // Le score retenu est le plus élevé : un détecteur qui voit le problème
    // l'emporte sur celui qui le manque.
    expect(orders[0]!.confidence_score).toBe(0.92);
    expect(result.stats.merged_duplicates).toBe(1);
  });

  it('exclut le finding porté par order.test.ts, et trace le motif', () => {
    const files = result.groups.flatMap((g) => g.vulnerabilities).map((v) => v.file);
    expect(files).not.toContain('src/orders/order.test.ts');
    expect(result.stats.excluded_non_production).toBe(1);
    expect(result.stats.exclusions.join(' ')).toContain('order.test.ts');
  });

  it('remonte la sévérité de /admin/users/:id malgré un score de 0.6', () => {
    const admin = result.groups
      .flatMap((g) => g.vulnerabilities)
      .find((v) => v.route === '/admin/users/:id')!;

    expect(admin.severity_base).toBe('high'); // base IDOR
    expect(admin.severity).toBe('critical'); // +1 pour /admin
    expect(admin.severity_adjustments.map((a) => a.steps)).toEqual([1]);
    expect(admin.confidence_score).toBe(0.6); // la confiance, elle, ne bouge pas
    expect(admin.routing).toBe('claude_arbitration');
  });

  it('route correctement les trois zones de confiance', () => {
    const all = [
      ...result.claude_payload,
      ...result.direct_alerts,
      ...result.rejected,
    ];
    for (const item of all) {
      if (item.confidence_score < REJECT_BELOW) expect(item.routing).toBe('rejected');
      else expect(item.routing).toBe('claude_arbitration'); // bypass désactivé par défaut
    }

    expect(result.rejected.map((r) => r.route).sort()).toEqual(['/preferences/:id', '/tags/:id']);
    expect(result.stats.rejected_low_confidence).toBe(2);
  });

  it('abaisse la sévérité sur une route explicitement publique', () => {
    const publicRoute = result.groups
      .flatMap((g) => g.vulnerabilities)
      .find((v) => v.route === '/public/articles/:id')!;
    expect(publicRoute.severity_base).toBe('high');
    expect(publicRoute.severity).toBe('medium'); // -1
  });

  it('trie les groupes par sévérité décroissante', () => {
    const severities = result.groups.map((g) => g.severity);
    const rank = ['critical', 'high', 'medium', 'low', 'info'];
    const positions = severities.map((s) => rank.indexOf(s));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('produit des statistiques complètes pour le run', () => {
    expect(result.stats).toMatchObject({
      total_received: 10,
      excluded_non_production: 1,
      merged_duplicates: 1,
      rejected_low_confidence: 2,
      routes_analyzed: 40,
    });
    // 10 reçus - 1 exclu - 1 fusionné = 8 retenus, dont 2 rejetés = 6 vers Claude.
    expect(result.stats.sent_to_claude).toBe(6);
  });
});

// ===========================================================================
// Correction n°1 — fusion par type, corrélation par emplacement
// ===========================================================================

describe('Fusion vs corrélation', () => {
  it("ne fusionne PAS un SQLi et un XSS situés sur la même ligne", () => {
    const result = aggregate(TEN_FINDINGS);
    const billing = result.groups.find((g) => g.route === '/billing/invoices/:id')!;

    // La spec dit « fusionner en un seul finding ». Ce serait une erreur :
    // un seul objet ne peut porter qu'un score et qu'une remédiation.
    expect(billing.vulnerabilities).toHaveLength(2);
    expect(billing.vulnerabilities.map((v) => v.vulnerability).sort()).toEqual(['SQLI', 'XSS']);
  });

  it('garde à chaque vulnérabilité son score, sa sévérité et son routing', () => {
    const result = aggregate(TEN_FINDINGS);
    const billing = result.groups.find((g) => g.route === '/billing/invoices/:id')!;

    const sqli = billing.vulnerabilities.find((v) => v.vulnerability === 'SQLI')!;
    const xss = billing.vulnerabilities.find((v) => v.vulnerability === 'XSS')!;

    // Une fusion aurait écrasé l'un des deux scores.
    expect(sqli.confidence_score).toBe(0.93);
    expect(xss.confidence_score).toBe(0.45);
    // Et l'une des deux sévérités : SQLi part de critical, XSS de medium.
    expect(sqli.severity).toBe('critical');
    expect(xss.severity).toBe('high'); // medium +1 (route financière)
  });

  it('regroupe quand même les deux pour l affichage, avec un résumé clair', () => {
    const result = aggregate(TEN_FINDINGS);
    const billing = result.groups.find((g) => g.route === '/billing/invoices/:id')!;
    expect(billing.plain_language_summary).toContain('2 different problems');
    expect(billing.plain_language_summary).toContain('fixed separately');
  });

  it('ne fusionne pas deux verbes HTTP différents sur la même route', () => {
    // GET /orders/:id (lecture non autorisée) et DELETE /orders/:id
    // (suppression non autorisée) sont deux problèmes distincts.
    const result = aggregate([
      finding({ http_method: 'GET', confidence_score: 0.8 }),
      finding({ http_method: 'DELETE', handler: 'deleteOrder', confidence_score: 0.8 }),
    ]);
    const routes = result.groups.flatMap((g) => g.vulnerabilities);
    expect(routes).toHaveLength(2);
    expect(routes.map((r) => r.http_method).sort()).toEqual(['DELETE', 'GET']);
  });
});

// ===========================================================================
// Correction n°2 — sévérité indépendante de la confiance
// ===========================================================================

describe('Sévérité et confiance sont deux axes distincts', () => {
  it("classe un doute grave au-dessus d'une certitude anodine", () => {
    const result = aggregate([
      // Certain, mais sur une route publique sans enjeu.
      finding({
        route: '/public/articles/:id',
        confidence_score: 0.95,
        file: 'src/a.controller.ts',
        detected_by: 'idor-node',
      }),
      // Incertain, mais sur l'administration.
      finding({
        route: '/admin/users/:id',
        confidence_score: 0.45,
        file: 'src/b.controller.ts',
        reason: 'ambiguous_logic',
        detected_by: 'idor-node',
      }),
    ]);

    // Un tri qui dériverait la sévérité du score mettrait la route publique
    // en tête. C'est l'inverse qu'il faut.
    expect(result.groups[0]!.route).toBe('/admin/users/:id');
    expect(result.groups[0]!.severity).toBe('critical');
    expect(result.groups[1]!.severity).toBe('medium');
  });

  it('cumule les ajustements de route', () => {
    const { severity, base, adjustments } = computeSeverity('IDOR', {
      route: '/admin/billing/invoices/:id',
      decorators: [],
    });
    expect(base).toBe('high');
    expect(adjustments).toHaveLength(2); // admin + financier
    expect(severity).toBe('critical'); // plafonné
  });

  it('reconnaît une route publique par décorateur, pas seulement par chemin', () => {
    const { severity } = computeSeverity('IDOR', {
      route: '/articles/:id',
      decorators: ['@Public()', "@Get('/:id')"],
    });
    expect(severity).toBe('medium'); // high -1
  });

  it('reconnaît « public » au milieu du chemin, pas seulement au début', () => {
    // Bug trouvé par la mesure de bout en bout : /orders/public/:id remontait
    // en HIGH parce que la règle testait startsWith('/public').
    expect(computeSeverity('IDOR', { route: '/orders/public/:id', decorators: [] }).severity).toBe(
      'medium'
    );
    expect(computeSeverity('IDOR', { route: '/api/v1/public/docs', decorators: [] }).severity).toBe(
      'medium'
    );
  });

  it('ne confond pas un segment avec une sous-chaîne', () => {
    // `includes('/admin')` matcherait /badminton — le découpage par segment évite ça.
    expect(computeSeverity('IDOR', { route: '/badminton/courts/:id', decorators: [] }).severity).toBe(
      'high'
    );
    expect(computeSeverity('IDOR', { route: '/publications/:id', decorators: [] }).severity).toBe('high');
  });

  it('ne descend jamais sous info ni au-dessus de critical', () => {
    expect(shiftSeverity('info', -5)).toBe('info');
    expect(shiftSeverity('critical', +5)).toBe('critical');
  });

  it('donne une sévérité prudente aux classes de vulnérabilité inconnues', () => {
    expect(baseSeverityFor('UNE_VULN_INEDITE')).toBe('medium');
  });
});

// ===========================================================================
// Correction n°3 — exclusions élargies
// ===========================================================================

describe('Exclusion des fichiers hors production', () => {
  it('couvre les conventions que la liste de la spec laissait passer', () => {
    // La spec ne liste que *.test.ts, *.spec.ts, mock/ et fixtures/.
    for (const file of [
      'src/orders/__tests__/order.controller.ts',
      'src/orders/__mocks__/order.service.ts',
      'src/nodes/idor/__fixtures__/repo/order.controller.ts',
      'e2e/checkout.controller.ts',
      'src/ui/Button.stories.tsx',
      'src/orders/order.spec.tsx',
    ]) {
      expect(classifySourcePath(file).excluded, file).toBe(true);
    }
  });

  it("n'écarte pas du code de production dont le nom ressemble", () => {
    for (const file of [
      'src/testing-utils/validator.controller.ts',
      'src/contests/contest.controller.ts',
      'src/fixtures-import/importer.controller.ts',
    ]) {
      expect(classifySourcePath(file).excluded, file).toBe(false);
    }
  });

  it('trace chaque exclusion au lieu de jeter en silence', () => {
    const result = aggregate([finding({ file: 'src/a/__fixtures__/x.controller.ts' })]);
    expect(result.stats.exclusions).toHaveLength(1);
    expect(result.stats.exclusions[0]).toContain('fixtures');
    expect(result.groups).toHaveLength(0);
  });
});

// ===========================================================================
// Correction n°4 — mesure du volume envoyé à Claude
// ===========================================================================

describe('Compteur de volume', () => {
  it('distingue le % des findings du % des routes analysées', () => {
    const result = aggregate(TEN_FINDINGS, { routesAnalyzed: 40 });

    // Sur les findings retenus, la proportion est forcément élevée : un node
    // ne remonte que ce qui est suspect.
    expect(result.stats.percent_of_findings_to_claude).toBe(75);
    // Rapporté au volume réellement scanné, on retombe dans la fourchette
    // 10-15 % de CLAUDE.md. C'est ce chiffre-là qui a un sens.
    expect(result.stats.percent_of_routes_to_claude).toBe(15);
  });

  it('renvoie null pour le % de routes quand le total n est pas fourni', () => {
    expect(aggregate(TEN_FINDINGS).stats.percent_of_routes_to_claude).toBeNull();
  });

  it('ne divise pas par zéro sur un run vide', () => {
    const empty = aggregate([]);
    expect(empty.stats.percent_of_findings_to_claude).toBe(0);
    expect(empty.groups).toHaveLength(0);
    expect(empty.plain_language_summary).toContain('no security issue');
  });
});

// ===========================================================================
// Routing et option bypass
// ===========================================================================

describe('Routing par confidence_score (CLAUDE.md §3)', () => {
  it('envoie tout à Claude par défaut, y compris les scores élevés', () => {
    const result = aggregate([finding({ confidence_score: 0.95 })]);
    expect(result.direct_alerts).toHaveLength(0);
    expect(result.claude_payload).toHaveLength(1);
  });

  it('active les alertes directes quand le bypass est demandé', () => {
    const result = aggregate([finding({ confidence_score: 0.95 })], {
      bypassClaudeForHighConfidence: true,
    });
    expect(result.direct_alerts).toHaveLength(1);
    expect(result.claude_payload).toHaveLength(0);
    expect(result.direct_alerts[0]!.routing).toBe('direct_alert');
  });

  it('traite les bornes exactement comme la grille de CLAUDE.md', () => {
    const atRejectBoundary = aggregate([finding({ confidence_score: REJECT_BELOW })]);
    expect(atRejectBoundary.stats.rejected_low_confidence).toBe(0); // 0.4 = zone grise

    const justBelow = aggregate([finding({ confidence_score: 0.399 })]);
    expect(justBelow.stats.rejected_low_confidence).toBe(1);

    const atAlertBoundary = aggregate([finding({ confidence_score: DIRECT_ALERT_ABOVE })], {
      bypassClaudeForHighConfidence: true,
    });
    expect(atAlertBoundary.direct_alerts).toHaveLength(0); // 0.7 reste zone grise
  });

  it('conserve un doute signalé par l un des détecteurs après fusion', () => {
    const result = aggregate([
      finding({ confidence_score: 0.6, reason: null, detected_by: 'a' }),
      finding({ confidence_score: 0.55, reason: 'missing_context', detected_by: 'b' }),
    ]);
    expect(result.claude_payload[0]!.reason).toBe('missing_context');
  });
});

// ===========================================================================
// Déterminisme et explicabilité
// ===========================================================================

describe('Déterminisme', () => {
  it('produit exactement le même résultat sur deux exécutions', () => {
    const a = aggregate(TEN_FINDINGS, { routesAnalyzed: 40 });
    const b = aggregate(TEN_FINDINGS, { routesAnalyzed: 40 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("ne dépend pas de l'ordre d'arrivée des findings", () => {
    const forward = aggregate(TEN_FINDINGS, { routesAnalyzed: 40 });
    const backward = aggregate([...TEN_FINDINGS].reverse(), { routesAnalyzed: 40 });
    expect(backward.groups.map((g) => `${g.http_method} ${g.route}`)).toEqual(
      forward.groups.map((g) => `${g.http_method} ${g.route}`)
    );
    expect(backward.stats.sent_to_claude).toBe(forward.stats.sent_to_claude);
  });
});

describe('Explicabilité (CLAUDE.md §4)', () => {
  const result = aggregate(TEN_FINDINGS, { routesAnalyzed: 40 });

  it('résume le run en français simple, sans jargon', () => {
    const summary = result.plain_language_summary;
    expect(summary.length).toBeGreaterThan(60);
    for (const jargon of ['JSON', 'confidence_score', 'payload', 'dedup', 'AST', 'routing']) {
      expect(summary.toLowerCase()).not.toContain(jargon.toLowerCase());
    }
    expect(summary).toContain('10 report(s) received');
  });

  it('explique chaque ajustement de sévérité en langage humain', () => {
    const admin = result.groups
      .flatMap((g) => g.vulnerabilities)
      .find((v) => v.route === '/admin/users/:id')!;
    expect(admin.severity_adjustments[0]!.reason).toContain("espace d'administration");
    expect(admin.severity_adjustments[0]!.reason).not.toContain('+1');
  });

  it('donne un résumé à chaque groupe', () => {
    for (const group of result.groups) {
      expect(group.plain_language_summary.length).toBeGreaterThan(20);
    }
  });
});

describe('Adaptation depuis un verdict de node (Phase 3)', () => {
  it('convertit un IdorVerdict en finding agrégeable', () => {
    const converted = fromNodeVerdict(
      {
        vulnerability: 'IDOR',
        route: '/orders/:id',
        http_method: 'GET',
        handler: 'getOrder',
        file: 'order.controller.ts',
        confidence_score: 0.9,
        reason: null,
        plain_language_summary: 'Résumé lisible.',
        technical_detail: { findings: [{ line: 42 }] },
      },
      'idor-node',
      ["@Get('/:id')"]
    );

    expect(converted).toMatchObject({
      vulnerability: 'IDOR',
      line: 42,
      detected_by: 'idor-node',
      decorators: ["@Get('/:id')"],
    });
    expect(aggregate([converted]).groups).toHaveLength(1);
  });

  it('supporte un verdict sans ligne identifiée', () => {
    const converted = fromNodeVerdict(
      {
        vulnerability: 'IDOR',
        route: '/x/:id',
        http_method: 'GET',
        handler: 'x',
        file: 'x.controller.ts',
        confidence_score: 0.5,
        reason: 'missing_context',
        plain_language_summary: 'Résumé.',
      },
      'idor-node'
    );
    expect(converted.line).toBeNull();
    expect(aggregate([converted]).groups).toHaveLength(1);
  });
});
