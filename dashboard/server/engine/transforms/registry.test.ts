/**
 * Test de complétude du registre.
 *
 * ============================================================================
 * LE SEUL TEST QUI RELIE LES DÉFINITIONS AU CODE
 *
 * Une définition désigne une transformation par son NOM. Ce nom est une
 * chaîne : le compilateur ne peut rien en dire. Un nœud pointant vers une
 * fonction renommée, supprimée ou mal orthographiée compile parfaitement, se
 * publie sans broncher, et échoue à la première alerte qui l'atteint —
 * peut-être des semaines plus tard, sur une branche rare.
 *
 * Ce fichier ferme ce trou dans les deux sens : aucun nom manquant, aucune
 * fonction morte.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import { buildRegistry } from './registry.ts';
import { PIPELINE_WORKFLOWS } from '../workflows/pipeline.ts';
import { ROUTING_WORKFLOWS } from '../workflows/routing.ts';

const ALL = [...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS];

const registry = () =>
  buildRegistry({
    now: () => new Date('2026-08-24T10:00:00.000Z'),
    resumeUrl: (runId: string) => `https://console.test/?run=${runId}`,
  });

/** Tous les noms référencés par les définitions, avec leur nœud d'origine. */
function referenced(): Array<{ workflow: string; node: string; fn: string }> {
  const out: Array<{ workflow: string; node: string; fn: string }> = [];
  for (const wf of ALL) {
    for (const node of wf.nodes) {
      const fn = node.params.fn;
      if (typeof fn === 'string') out.push({ workflow: wf.id, node: node.id, fn });
    }
  }
  return out;
}

describe('chaque nom référencé existe', () => {
  it('aucun nœud ne pointe vers une fonction absente', () => {
    const r = registry();
    const missing = referenced().filter((ref) => !r.get(ref.fn));
    expect(
      missing.map((m) => `${m.workflow}/${m.node} → « ${m.fn} »`),
      'transformations référencées mais non enregistrées',
    ).toEqual([]);
  });

  it('couvre les six workflows', () => {
    const workflows = new Set(referenced().map((r) => r.workflow));
    expect(workflows.size).toBe(6);
  });
});

describe('aucune fonction morte', () => {
  it('tout ce qui est enregistré est utilisé par au moins un nœud', () => {
    // Une fonction que plus aucun nœud n'appelle est du code qu'on maintient
    // pour rien — et qui donne l'illusion d'une étape qui a lieu.
    const used = new Set(referenced().map((r) => r.fn));
    const dead = registry().names().filter((name) => !used.has(name));
    expect(dead, 'transformations enregistrées mais jamais appelées').toEqual([]);
  });
});

describe('le registre refuse ce qui prêterait à confusion', () => {
  it('refuse un doublon plutôt que d’écraser en silence', () => {
    const r = registry();
    expect(() => r.register('validateAlertSchema', (i) => i)).toThrow(/already registered/);
  });

  it('rend `undefined` — pas une fonction vide — pour un nom inconnu', () => {
    // Rendre une fonction neutre ferait « marcher » un nœud cassé.
    expect(registry().get('nexistePas')).toBeUndefined();
  });
});

describe('les variables absentes sont refusées, jamais inventées', () => {
  it('nomme la variable manquante', () => {
    const fn = registry().get('shadowOutcome')!;
    expect(() => fn({ alert: {}, rows: [] }, new Map(), { runId: 'run-1' }))
      .toThrow(/shadow\.exitThreshold/);
  });

  it('refuse une variable qui n’est pas un nombre', () => {
    const fn = registry().get('shadowOutcome')!;
    expect(() => fn({ alert: {}, rows: [] }, new Map([['shadow.exitThreshold', 'beaucoup']]), { runId: 'run-1' }))
      .toThrow(/n'est pas un nombre/);
  });
});

describe("l'identifiant d'exécution vient de l'exécution, pas d'un global", () => {
  it("écrit le run reçu dans la ligne d'audit", () => {
    // `execution_id` est ce qui rattache une ligne d'audit à son exécution.
    // Il était alimenté par une variable de module jamais affectée : toutes
    // les lignes partaient avec la chaîne vide, et la chaîne hachée perdait
    // son lien vers ce qui l'avait produite.
    const fn = registry().get('normalizeAuditRow')!;
    const out = fn({ alert_id: 'A-1' }, new Map(), { runId: 'run-42' }) as {
      row_ok: boolean;
      row: Record<string, unknown>;
    };
    expect(out.row_ok).toBe(true);
    expect(out.row.execution_id).toBe('run-42');
  });

  it('donne deux URL de reprise différentes à deux exécutions différentes', () => {
    // La preuve que la valeur voyage PAR L'APPEL : un global rendrait les deux
    // identiques, ce qui est aussi ce qui se passerait si deux alertes étaient
    // traitées en même temps.
    const fn = registry().get('buildApprovalRequest')!;
    const vars = new Map<string, unknown>([
      ['isolation.ttlMinutes', 60],
      ['endpoint.isolation', 'https://mock.test/isolate'],
      ['slack.approvalChannel', '#soc-approvals'],
      ['slack.escalationChannel', '#soc-escalation'],
      ['approval.timeoutMinutes', 30],
    ]);
    const alert = {
      alert_id: 'A-1', rule_name: 'r', severity: 'high',
      source_ip: '1.1.1.1', dest_ip: '2.2.2.2',
      enrichment: {},
      decision: {
        verdict: 'true_positive', confidence: 0.9, raw_confidence: 0.9,
        recommended_action: 'ticket', decision_source: 'llm',
        data_lineage: [], guardrails_applied: [], reasoning: 'x',
      },
    };
    const a = fn({ alert }, vars, { runId: 'run-A' }) as { resume_url: string };
    const b = fn({ alert }, vars, { runId: 'run-B' }) as { resume_url: string };
    expect(a.resume_url).toContain('run-A');
    expect(b.resume_url).toContain('run-B');
    expect(a.resume_url).not.toBe(b.resume_url);
  });
});
