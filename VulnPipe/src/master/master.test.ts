/**
 * Tests du master + construction du rapport.
 *
 * Comme en Phase 3, les tests n'appellent pas l'API réelle : ils vérifient la
 * LOGIQUE (recollage des verdicts, filtrage, comptes, garde-anti-patch,
 * comportement en panne). L'appel réel est dans `npm run report` — sa sortie
 * est recopiée en bas de ce fichier et dans ROADMAP.md.
 */

import { describe, it, expect } from 'vitest';

import { aggregate, type NodeFinding } from '../aggregator/aggregator.ts';
import { FakeLlmClient } from '../nodes/shared/llm/fake.ts';
import { LlmError } from '../nodes/shared/llm/types.ts';
import { arbitrate, findingId, MASTER_SYSTEM_PROMPT } from './claude-client.ts';
import { buildReport, containsCodePatch, toReportLevel } from './report-builder.ts';

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
    plain_language_summary: "N'importe qui peut lire les commandes des autres.",
    decorators: [],
    detected_by: 'idor-node',
    ...overrides,
  };
}

/** Le jeu de 10 findings de la Phase 4, réutilisé comme le demande la spec. */
const TEN_FINDINGS: NodeFinding[] = [
  finding({ detected_by: 'idor-node', confidence_score: 0.85 }),
  finding({ detected_by: 'idor-node-v2', confidence_score: 0.92 }),
  finding({ file: 'src/orders/order.test.ts', confidence_score: 0.95 }),
  finding({
    route: '/admin/users/:id',
    handler: 'getUser',
    file: 'src/admin/admin.controller.ts',
    line: 22,
    confidence_score: 0.6,
    reason: 'ambiguous_logic',
  }),
  finding({
    route: '/carts/:id',
    handler: 'getCart',
    file: 'src/carts/cart.controller.ts',
    line: 8,
    confidence_score: 0.55,
    reason: 'missing_context',
  }),
  finding({ route: '/preferences/:id', file: 'src/prefs/pref.controller.ts', confidence_score: 0.15 }),
  finding({ route: '/tags/:id', file: 'src/tags/tag.controller.ts', confidence_score: 0.39 }),
  finding({
    route: '/public/articles/:id',
    file: 'src/articles/article.controller.ts',
    confidence_score: 0.88,
  }),
  finding({
    vulnerability: 'SQLI',
    route: '/billing/invoices/:id',
    file: 'src/billing/billing.controller.ts',
    line: 31,
    confidence_score: 0.93,
    detected_by: 'sqli-node',
  }),
  finding({
    vulnerability: 'XSS',
    route: '/billing/invoices/:id',
    file: 'src/billing/billing.controller.ts',
    line: 31,
    confidence_score: 0.45,
    reason: 'ambiguous_logic',
    detected_by: 'xss-node',
  }),
];

const aggregation = aggregate(TEN_FINDINGS, { routesAnalyzed: 40 });
const candidates = [...aggregation.claude_payload, ...aggregation.direct_alerts];

/** Fabrique une réponse d'arbitre couvrant tous les candidats. */
function verdictsFor(
  overrides: Record<string, Partial<{ claude_verdict: string; suggested_fix_direction: string }>> = {}
) {
  return {
    verdicts: candidates.map((f) => {
      const id = findingId(f);
      return {
        finding_id: id,
        claude_verdict: 'confirmed',
        claude_reasoning: 'Le code montre une lecture par identifiant sans vérification du propriétaire.',
        technical_summary: `${f.vulnerability} sur ${f.route}, ligne ${f.line}. Aucun contrôle d'appartenance.`,
        plain_language_summary:
          "Quelqu'un peut changer le numéro dans la barre d'adresse et voir les informations d'un autre client.",
        suggested_fix_direction:
          "Il faut vérifier que la donnée demandée appartient bien à la personne connectée avant de la renvoyer.",
        owasp_category: 'A01:2021 – Broken Access Control',
        ...overrides[id],
      };
    }),
  };
}

// ===========================================================================
// Cas de test imposé par PHASE_5
// ===========================================================================

describe('Cas de test imposé par PHASE_5 — payload des 10 findings', () => {
  it('classe les findings validés en critical ou warning selon la sévérité', async () => {
    const outcome = await arbitrate(candidates, { llm: new FakeLlmClient([{ parsed: verdictsFor() }]) });
    const report = buildReport(aggregation, outcome, { routesAnalyzed: 40 });

    // SQLi sur route financière -> critical ; XSS -> high -> critical aussi.
    const sqli = report.findings.find((f) => f.vulnerability === 'SQLI')!;
    expect(sqli.severity).toBe('critical');
    expect(sqli.report_level).toBe('critical');

    // /public/articles/:id -> medium -> warning
    const publicRoute = report.findings.find((f) => f.route === '/public/articles/:id')!;
    expect(publicRoute.severity).toBe('medium');
    expect(publicRoute.report_level).toBe('warning');

    expect(report.scan_summary.critical + report.scan_summary.warning).toBe(
      report.scan_summary.total_findings
    );
  });

  it('donne à chaque finding les DEUX résumés, technique et langage simple', async () => {
    const outcome = await arbitrate(candidates, { llm: new FakeLlmClient([{ parsed: verdictsFor() }]) });
    const report = buildReport(aggregation, outcome);

    for (const item of report.findings) {
      expect(item.technical_summary.length).toBeGreaterThan(10);
      expect(item.plain_language_summary.length).toBeGreaterThan(10);
      expect(item.technical_summary).not.toBe(item.plain_language_summary);
      expect(item.suggested_fix_direction.length).toBeGreaterThan(10);
      expect(item.owasp_category).toContain('A01');
    }
  });

  it('retire du rapport visible un finding rejeté, mais le garde pour la calibration', async () => {
    const rejectedId = findingId(candidates[0]!);
    const outcome = await arbitrate(candidates, {
      llm: new FakeLlmClient([{ parsed: verdictsFor({ [rejectedId]: { claude_verdict: 'rejected' } }) }]),
    });
    const report = buildReport(aggregation, outcome);

    expect(report.findings.map(findingKey)).not.toContain(rejectedId);
    expect(report.dismissed).toHaveLength(1);
    expect(report.dismissed[0]!.claude_reasoning.length).toBeGreaterThan(10);
    expect(report.scan_summary.dismissed_by_arbiter).toBe(1);
    // Compté dans l'intro : l'utilisateur doit savoir que l'outil a regardé.
    expect(report.scan_summary.plain_language_intro).toContain('dismissed');
  });
});

function findingKey(f: { vulnerability: string; http_method: string; route: string }): string {
  return `${f.vulnerability}:${f.http_method}:${f.route}`;
}

// ===========================================================================
// Correction n°1 — l'arbitre doit voir le code
// ===========================================================================

describe("L'arbitre reçoit le code, pas seulement le résumé du node", () => {
  it('marque summary_only quand aucun contexte de code n est fourni', async () => {
    const llm = new FakeLlmClient([{ parsed: verdictsFor() }]);
    const outcome = await arbitrate(candidates, { llm });

    // Sans ContextProvider, l'arbitrage ne peut être qu'une reformulation.
    expect(outcome.arbitrated.every((a) => a.evidence === 'summary_only')).toBe(true);
    expect(llm.requests[0]!.user).toContain('code non disponible');
  });

  it('injecte le code réel de la route quand un ContextProvider est fourni', async () => {
    const fakeProvider = {
      async getContext() {
        return {
          endpoint: {
            code_snapshot: 'async getOrder(id) { return this.orderService.findById(id); }',
            source: { file: 'order.controller.ts', start_line: 10, end_line: 13 },
          },
          resolved_guards: [
            {
              guard: 'OwnershipGuard',
              resolution_status: 'resolved',
              candidates: [{ code_snapshot: 'return order.userId === request.user.id;' }],
              resolved_calls: [],
              reason: null,
            },
          ],
          resolved_calls: [
            {
              call: 'findById',
              receiver: 'orderService',
              candidates: [
                {
                  class_name: 'OrderService',
                  method: 'findById',
                  file: 'order.service.ts',
                  start_line: 2,
                  code_snapshot: 'return this.db.orders.findOne({ id });',
                },
              ],
              resolved_calls: [],
            },
          ],
        } as never;
      },
      async listRoutes() {
        return [];
      },
      async close() {},
    };

    const llm = new FakeLlmClient([{ parsed: verdictsFor() }]);
    const outcome = await arbitrate(candidates.slice(0, 1), { llm, contextProvider: fakeProvider });

    const sent = llm.requests[0]!.user;
    // Sans ces trois éléments, l'arbitre ne peut pas contredire le node.
    expect(sent).toContain('this.orderService.findById(id)');
    expect(sent).toContain('order.userId === request.user.id');
    expect(sent).toContain('this.db.orders.findOne({ id })');
    expect(outcome.arbitrated[0]!.evidence).toBe('code');
  });

  it("retombe sur summary_only si le contexte n'est pas récupérable", async () => {
    const brokenProvider = {
      async getContext(): Promise<never> {
        throw new Error('serveur MCP injoignable');
      },
      async listRoutes() {
        return [];
      },
      async close() {},
    };
    const outcome = await arbitrate(candidates.slice(0, 1), {
      llm: new FakeLlmClient([{ parsed: verdictsFor() }]),
      contextProvider: brokenProvider,
    });
    expect(outcome.arbitrated[0]!.evidence).toBe('summary_only');
  });
});

// ===========================================================================
// Correction n°2 — une panne ne doit jamais effacer un finding
// ===========================================================================

describe('Robustesse : aucun finding ne disparaît sur panne', () => {
  it("republie tous les findings quand l'arbitre est indisponible", async () => {
    const outcome = await arbitrate(candidates, {
      llm: new FakeLlmClient([
        { error: new LlmError('anthropic', 'unavailable', 'API injoignable', true) },
      ]),
    });
    expect(outcome.arbitrated).toHaveLength(0);
    expect(outcome.unarbitrated).toHaveLength(candidates.length);

    const report = buildReport(aggregation, outcome);
    // Le rapport reste complet : une panne réseau ne doit pas se lire
    // « rien à signaler ».
    expect(report.findings).toHaveLength(candidates.length);
    expect(report.scan_summary.not_arbitrated).toBe(candidates.length);
    for (const item of report.findings) {
      expect(item.claude_verdict).toBe('needs_human_review');
      expect(item.evidence).toBe('not_arbitrated');
    }
    expect(report.scan_summary.plain_language_intro).toContain('could not be double-checked');
  });

  it("récupère un verdict manquant dans une réponse partielle", async () => {
    const partial = verdictsFor();
    partial.verdicts = partial.verdicts.slice(0, 2); // l'arbitre en oublie
    const outcome = await arbitrate(candidates, { llm: new FakeLlmClient([{ parsed: partial }]) });

    expect(outcome.arbitrated).toHaveLength(2);
    expect(outcome.unarbitrated).toHaveLength(candidates.length - 2);

    const report = buildReport(aggregation, outcome);
    expect(report.findings).toHaveLength(candidates.length); // aucun perdu
  });

  it('ne plante pas sur un payload vide et n appelle pas l API', async () => {
    const llm = new FakeLlmClient([{ parsed: verdictsFor() }]);
    const outcome = await arbitrate([], { llm });
    expect(llm.callCount).toBe(0);
    expect(outcome.usage.calls).toBe(0);

    const report = buildReport(aggregate([]), outcome);
    expect(report.findings).toHaveLength(0);
    expect(report.scan_summary.plain_language_intro).toContain('Good news');
  });
});

// ===========================================================================
// Correction n°3 — verdict ternaire
// ===========================================================================

describe('Verdict « à faire revoir »', () => {
  it('garde visible un finding que l arbitre ne sait pas trancher', async () => {
    const id = findingId(candidates[0]!);
    const outcome = await arbitrate(candidates, {
      llm: new FakeLlmClient([
        { parsed: verdictsFor({ [id]: { claude_verdict: 'needs_human_review' } }) },
      ]),
    });
    const report = buildReport(aggregation, outcome);

    const item = report.findings.find((f) => findingKey(f) === id)!;
    expect(item.claude_verdict).toBe('needs_human_review');
    // Un binaire confirmed/rejected aurait forcé un rejet — donc la
    // disparition silencieuse d'une vulnérabilité peut-être réelle.
    expect(report.dismissed.map((d) => d.route)).not.toContain(item.route);
  });

  it('demande explicitement à l arbitre de préférer le doute au rejet', () => {
    expect(MASTER_SYSTEM_PROMPT).toContain('préférez "needs_human_review" à "rejected"');
  });
});

// ===========================================================================
// Correction n°4 — la contrainte « pas de patch » vérifiée en code
// ===========================================================================

describe('Contrainte : jamais de patch de code applicable', () => {
  it('détecte les formes courantes de patch', () => {
    expect(containsCodePatch('```ts\nconst x = 1;\n```')).toBe(true);
    expect(containsCodePatch('--- a/file.ts\n+++ b/file.ts')).toBe(true);
    expect(containsCodePatch('@@ -1,3 +1,4 @@')).toBe(true);
    expect(containsCodePatch('+ const owner = await check();')).toBe(true);
    expect(
      containsCodePatch(
        "Il faut vérifier que la commande appartient à la personne connectée avant de la renvoyer."
      )
    ).toBe(false);
  });

  it('retire un patch glissé par le modèle malgré la consigne', async () => {
    const id = findingId(candidates[0]!);
    const outcome = await arbitrate(candidates, {
      llm: new FakeLlmClient([
        {
          parsed: verdictsFor({
            [id]: {
              suggested_fix_direction:
                'Ajoute ceci :\n```ts\nif (order.userId !== req.user.id) throw new ForbiddenException();\n```',
            },
          }),
        },
      ]),
    });
    const report = buildReport(aggregation, outcome);
    const item = report.findings.find((f) => findingKey(f) === id)!;

    expect(item.suggested_fix_direction).not.toContain('```');
    expect(item.suggested_fix_direction).not.toContain('ForbiddenException');
    expect(report.scan_summary.plain_language_intro).toContain('in words, not in code');
  });

  it("l'interdiction figure explicitement dans le prompt système", () => {
    expect(MASTER_SYSTEM_PROMPT).toContain('CONTRAINTE ABSOLUE');
    expect(MASTER_SYSTEM_PROMPT).toContain('JAMAIS de patch');
  });
});

// ===========================================================================
// Correspondance des échelles de sévérité
// ===========================================================================

describe('Correspondance sévérité -> niveau de rapport', () => {
  it('rend explicite le passage de 5 niveaux à 2', () => {
    expect(toReportLevel('critical')).toBe('critical');
    expect(toReportLevel('high')).toBe('critical');
    expect(toReportLevel('medium')).toBe('warning');
    expect(toReportLevel('low')).toBe('warning');
    expect(toReportLevel('info')).toBe('warning');
  });

  it('conserve les 5 niveaux dans le rapport pour l UI de la Phase 6', async () => {
    const outcome = await arbitrate(candidates, { llm: new FakeLlmClient([{ parsed: verdictsFor() }]) });
    const report = buildReport(aggregation, outcome);
    const levels = new Set(report.findings.map((f) => f.severity));
    expect(levels.size).toBeGreaterThan(1); // pas aplati à critical/warning
  });
});

// ===========================================================================
// Explicabilité et déterminisme
// ===========================================================================

describe('Rapport final', () => {
  it("écrit une introduction en français simple, sans jargon", async () => {
    const outcome = await arbitrate(candidates, { llm: new FakeLlmClient([{ parsed: verdictsFor() }]) });
    const intro = buildReport(aggregation, outcome, { routesAnalyzed: 40 }).scan_summary
      .plain_language_intro;

    expect(intro.length).toBeGreaterThan(40);
    for (const jargon of ['IDOR', 'endpoint', 'payload', 'JSON', 'confidence_score', 'OWASP']) {
      expect(intro).not.toContain(jargon);
    }
    expect(intro).toContain('40 addresses');
  });

  it('signale une couverture partielle au lieu de la passer sous silence', async () => {
    const outcome = await arbitrate(candidates, { llm: new FakeLlmClient([{ parsed: verdictsFor() }]) });
    const report = buildReport(aggregation, outcome, { routesAnalyzed: 40, routesFailed: 3 });
    expect(report.scan_summary.plain_language_intro).toContain('scan is incomplete');
  });

  it('produit un rapport trié et sérialisable au format de la Phase 6', async () => {
    const outcome = await arbitrate(candidates, { llm: new FakeLlmClient([{ parsed: verdictsFor() }]) });
    const report = JSON.parse(JSON.stringify(buildReport(aggregation, outcome)));

    expect(report.scan_summary).toEqual(
      expect.objectContaining({
        total_findings: expect.any(Number),
        critical: expect.any(Number),
        warning: expect.any(Number),
        plain_language_intro: expect.any(String),
      })
    );
    expect(report.findings[0]).toEqual(
      expect.objectContaining({
        severity: expect.any(String),
        vulnerability: expect.any(String),
        route: expect.any(String),
        claude_verdict: expect.any(String),
        claude_reasoning: expect.any(String),
        technical_summary: expect.any(String),
        plain_language_summary: expect.any(String),
        suggested_fix_direction: expect.any(String),
      })
    );

    const rank = ['critical', 'high', 'medium', 'low', 'info'];
    const positions = report.findings.map((f: { severity: string }) => rank.indexOf(f.severity));
    expect(positions).toEqual([...positions].sort((a: number, b: number) => a - b));
  });

  it('reste reproductible sur deux constructions identiques', async () => {
    const build = async () => {
      const outcome = await arbitrate(candidates, {
        llm: new FakeLlmClient([{ parsed: verdictsFor() }]),
      });
      return JSON.stringify(buildReport(aggregation, outcome, { routesAnalyzed: 40 }));
    };
    expect(await build()).toBe(await build());
  });

  it("reprend les statistiques de l'Agrégateur sans les recalculer", async () => {
    const outcome = await arbitrate(candidates, { llm: new FakeLlmClient([{ parsed: verdictsFor() }]) });
    const report = buildReport(aggregation, outcome);
    expect(report.aggregator_stats).toEqual(aggregation.stats);
  });
});

// ===========================================================================
// Reprise sur quota (observée en conditions réelles : palier gratuit Gemini)
// ===========================================================================

describe('Reprise sur erreur transitoire', () => {
  it('réessaie une erreur de quota et finit par aboutir', async () => {
    const { withRetry } = await import('../nodes/shared/llm/types.ts');
    let calls = 0;
    const waits: number[] = [];

    const value = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new LlmError('gemini', 'rate_limit', 'Quota exceeded. Please retry in 0.01s', true);
        }
        return 'ok';
      },
      // `random: () => 0` : sans lui le jitter rendrait la durée du test
      // aléatoire — on mesure la règle, pas le tirage.
      { onWait: (ms) => waits.push(ms), random: () => 0, sleep: async () => {} }
    );

    expect(value).toBe('ok');
    expect(calls).toBe(3);
    // Le délai indiqué par l'API est suivi plutôt que deviné.
    expect(waits[0]).toBeLessThan(1000);
  });

  it("ajoute du jitter au-dessus du délai imposé, jamais en dessous", async () => {
    const { withRetry } = await import('../nodes/shared/llm/types.ts');
    const waits: number[] = [];

    // Les deux extrêmes du tirage : `sleep` est neutralisé, donc l'amplitude
    // ne coûte plus de temps d'exécution.
    for (const draw of [0, 1]) {
      waits.length = 0;
      let calls = 0;
      await withRetry(
        async () => {
          calls += 1;
          if (calls < 2) {
            throw new LlmError('gemini', 'rate_limit', 'Quota exceeded. Please retry in 0.01s', true);
          }
          return 'ok';
        },
        { onWait: (ms) => waits.push(ms), random: () => draw, sleep: async () => {} }
      );
      // Le plancher imposé par l'API (10 ms + 500 de marge) n'est jamais
      // raccourci : un jitter qui ferait repartir AVANT garantirait un
      // second refus.
      expect(waits[0]).toBeGreaterThanOrEqual(510);
    }
  });

  it('étale les reprises simultanées plutôt que de reformer le troupeau', async () => {
    const { withRetry } = await import('../nodes/shared/llm/types.ts');
    // Quatre appels en vol franchissent le quota au même instant et
    // reçoivent le même délai suggéré. Sans jitter ils repartiraient tous
    // ensemble ; on vérifie que les attentes diffèrent.
    const draws = [0, 0.25, 0.5, 0.75];
    const waits = await Promise.all(
      draws.map(async (draw) => {
        let observed = 0;
        let calls = 0;
        await withRetry(
          async () => {
            calls += 1;
            if (calls < 2) throw new LlmError('gemini', 'rate_limit', 'Quota exceeded. Please retry in 0.01s', true);
            return 'ok';
          },
          { onWait: (ms) => (observed = ms), random: () => draw, sleep: async () => {} }
        );
        return observed;
      })
    );

    expect(new Set(waits).size).toBe(draws.length);
  });

  it("n'insiste jamais sur une clé invalide", async () => {
    const { withRetry } = await import('../nodes/shared/llm/types.ts');
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls += 1;
        throw new LlmError('gemini', 'auth', 'clé invalide', false);
      })
    ).rejects.toThrow(LlmError);
    expect(calls).toBe(1);
  });
});
