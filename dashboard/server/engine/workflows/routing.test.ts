/**
 * Tests des définitions 04 → 06.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT
 *
 * 04 est le SEUL workflow qui touche au monde réel. Les tests ci-dessous
 * relisent son graphe et vérifient, sur la structure elle-même, qu'aucun
 * chemin ne mène à l'exécution d'une action sans passer par l'attente humaine
 * et en sortir par le port `main`.
 *
 * C'est une garantie qu'aucun test unitaire ne peut donner : elle ne porte pas
 * sur une fonction, mais sur la FORME du graphe. Un lien ajouté par erreur la
 * casserait sans qu'aucune fonction ne change.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import { assertAcyclic } from '../engine.ts';
import { NODE_EFFECTS, type WorkflowDef } from '../types.ts';
import { validateCondition, type Condition } from '../values.ts';
import { AUDIT, ERRORS, ROUTING, ROUTING_WORKFLOWS } from './routing.ts';
import { PIPELINE_WORKFLOWS } from './pipeline.ts';

const ALL = [...PIPELINE_WORKFLOWS, ...ROUTING_WORKFLOWS];

describe.each(ROUTING_WORKFLOWS.map((wf) => [wf.id, wf] as const))(
  'intégrité de %s',
  (_name, wf: WorkflowDef) => {
    it('n’a aucun lien vers un nœud inexistant', () => {
      const ids = new Set(wf.nodes.map((n) => n.id));
      for (const edge of wf.edges) {
        expect(ids.has(edge.from), `depuis « ${edge.from} »`).toBe(true);
        expect(ids.has(edge.to), `vers « ${edge.to} »`).toBe(true);
      }
    });

    it('n’a aucun nœud orphelin', () => {
      const reached = new Set(wf.edges.map((e) => e.to));
      const orphans = wf.nodes
        .filter((n) => !n.type.startsWith('trigger.') && !reached.has(n.id))
        .map((n) => n.id);
      expect(orphans).toEqual([]);
    });

    it('n’a pas de cycle', () => {
      expect(() => assertAcyclic(wf)).not.toThrow();
    });

    it('câble les deux ports de chaque `if`', () => {
      for (const node of wf.nodes.filter((n) => n.type === 'if')) {
        const ports = new Set(wf.edges.filter((e) => e.from === node.id).map((e) => e.fromPort));
        expect([...ports].sort(), node.id).toEqual(['false', 'true']);
      }
    });

    it('a un repli sur chaque `switch`, ET le câble', () => {
      for (const node of wf.nodes.filter((n) => n.type === 'switch')) {
        const fallback = node.params.fallbackPort as string;
        expect(typeof fallback, node.id).toBe('string');
        // Un repli déclaré mais non câblé ne vaut pas mieux qu'une absence de
        // repli : le flux s'arrêterait là, en silence.
        const wired = wf.edges.some((e) => e.from === node.id && e.fromPort === fallback);
        expect(wired, `« ${node.id} » : repli « ${fallback} » non câblé`).toBe(true);
      }
    });

    it('câble tous les cas déclarés d’un `switch`', () => {
      for (const node of wf.nodes.filter((n) => n.type === 'switch')) {
        const cases = (node.params.cases ?? []) as Array<{ port: string; when: Condition }>;
        for (const branch of cases) {
          const wired = wf.edges.some((e) => e.from === node.id && e.fromPort === branch.port);
          expect(wired, `« ${node.id} » : cas « ${branch.port} » non câblé`).toBe(true);
          expect(() => validateCondition(branch.when), branch.port).not.toThrow();
        }
      }
    });

    it('donne une issue à chaque appel externe', () => {
      for (const node of wf.nodes) {
        if (NODE_EFFECTS[node.type] === 'pure' || node.type === 'subflow' || node.type === 'wait') continue;
        const hasError = wf.edges.some((e) => e.from === node.id && e.fromPort === 'error');
        expect(hasError || node.retry !== undefined, `« ${node.id} »`).toBe(true);
      }
    });
  },
);

// =============================================================================
/** Tous les nœuds atteignables depuis `start` en suivant les liens. */
function reachableFrom(wf: WorkflowDef, start: string, viaPort?: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  const first = wf.edges.filter((e) => e.from === start && (viaPort === undefined || e.fromPort === viaPort));
  for (const e of first) queue.push(e.to);

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of wf.edges.filter((x) => x.from === id)) queue.push(e.to);
  }
  return seen;
}

describe('04 — LA garantie du produit', () => {
  it('l’exécution d’une action n’est atteignable QUE par le port « main » de l’attente', () => {
    // LE TEST LE PLUS IMPORTANT DU FICHIER.
    //
    // Il ne teste pas une fonction, il teste la FORME du graphe : un lien
    // ajouté par erreur casserait la garantie sans qu'aucune fonction ne
    // change, donc sans qu'aucun test unitaire ne bronche.
    const viaApproval = reachableFrom(ROUTING, 'attente', 'main');
    expect(viaApproval.has('execute')).toBe(true);

    // Et par AUCUN autre chemin : ni le shadow mode, ni l'expiration, ni
    // l'échec de publication.
    for (const [node, port] of [['attente', 'timeout'], ['shadow', 'true'], ['post-approval', 'error']] as const) {
      const reachable = reachableFrom(ROUTING, node, port);
      expect(reachable.has('execute'), `« ${node} » port « ${port} » atteint l'exécution`).toBe(false);
    }
  });

  it('le port « timeout » mène à une escalade, jamais à une action', () => {
    const onTimeout = reachableFrom(ROUTING, 'attente', 'timeout');
    expect(onTimeout.has('escalate-timeout')).toBe(true);
    expect(onTimeout.has('execute')).toBe(false);
    expect(onTimeout.has('catalog')).toBe(false);
  });

  it('un rejet humain n’exécute rien', () => {
    const onReject = reachableFrom(ROUTING, 'approved', 'false');
    expect(onReject.has('execute')).toBe(false);
    expect(onReject.has('audit-record')).toBe(true);
  });

  it('le shadow mode ne publie AUCUNE notification', () => {
    // « aucune action réelle, aucune notification bruyante » : le graphe doit
    // le garantir, pas seulement le commentaire.
    const inShadow = reachableFrom(ROUTING, 'shadow', 'true');
    const slackNodes = ROUTING.nodes.filter((n) => n.type === 'notify').map((n) => n.id);
    for (const id of slackNodes) {
      expect(inShadow.has(id), `« ${id} » atteint en shadow mode`).toBe(false);
    }
  });

  it('TOUTES les branches convergent vers l’audit', () => {
    // Une branche qui n'écrirait pas d'audit ferait disparaître un cas de la
    // file de triage sans laisser de trace.
    const terminals = ['shadow-count', 'notify-failed', 'escalate-timeout', 'rejected', 'execute', 'execute-failed'];
    for (const id of terminals) {
      const reaches = ROUTING.edges.some((e) => e.from === id && e.to === 'audit-record');
      expect(reaches, `« ${id} » n'atteint pas l'audit`).toBe(true);
    }
  });

  it('le décompte du shadow mode lit l’AUDIT, pas une mémoire de processus', () => {
    // Sous n8n : `$getWorkflowStaticData`, remis à zéro à chaque redémarrage.
    // « 50 alertes observées » ne voulait alors rien dire.
    const node = ROUTING.nodes.find((n) => n.id === 'baseline-query');
    expect(node?.type).toBe('postgres');
    expect(String(node?.params.sql)).toMatch(/FROM soc_audit_log/);
  });

  it('l’attente tire son délai d’une variable modifiable', () => {
    const node = ROUTING.nodes.find((n) => n.id === 'attente');
    expect(node?.params.timeoutMinutes).toMatchObject({ kind: 'var' });
  });
});

describe('05 — la preuve avant les mesures', () => {
  it('des mesures indisponibles ne font pas échouer l’écriture', () => {
    // À ce stade la preuve est déjà en base : la perdre pour une requête
    // d'agrégation serait absurde.
    const ports = AUDIT.edges
      .filter((e) => e.from === 'metrics' && e.to === 'expose')
      .map((e) => e.fromPort);
    expect(ports.sort()).toEqual(['error', 'main']);
  });

  it('l’écriture d’audit réessaie avant d’abandonner', () => {
    expect(AUDIT.nodes.find((n) => n.id === 'append')?.retry?.attempts).toBeGreaterThanOrEqual(3);
  });

  it('une ligne sans alert_id n’est pas écrite en base', () => {
    const unusable = AUDIT.edges.find((e) => e.from === 'row-ok' && e.fromPort === 'false');
    expect(unusable?.to).toBe('unusable');
    expect(AUDIT.edges.some((e) => e.from === 'unusable' && e.to === 'append')).toBe(false);
  });

  it('l’écriture est paramétrée, jamais interpolée', () => {
    const sql = String(AUDIT.nodes.find((n) => n.id === 'append')?.params.sql);
    expect(sql).toMatch(/\$1.*\$24/s);
    // Aucune concaténation de valeur dans le texte SQL.
    expect(sql).not.toMatch(/\$\{/);
  });
});

describe('06 — le dernier filet ne se rappelle jamais lui-même', () => {
  it('n’a aucun appel de sous-workflow', () => {
    // Une erreur dans le gestionnaire d'erreurs ne doit pas déclencher le
    // gestionnaire d'erreurs. Une boucle d'incidents noie tout le reste.
    expect(ERRORS.nodes.filter((n) => n.type === 'subflow')).toEqual([]);
  });

  it('alerte même quand la journalisation échoue', () => {
    // Ne pas pouvoir journaliser n'est jamais une raison de ne pas alerter.
    const ports = ERRORS.edges
      .filter((e) => e.from === 'log' && e.to === 'assess')
      .map((e) => e.fromPort);
    expect(ports.sort()).toEqual(['error', 'main']);
  });

  it('une route inconnue notifie le canal critique plutôt que de disparaître', () => {
    const route = ERRORS.nodes.find((n) => n.id === 'route');
    expect(route?.params.fallbackPort).toBe('critique');
    const target = ERRORS.edges.find((e) => e.from === 'route' && e.fromPort === 'critique')?.to;
    expect(target).toBe('notify-critical');
  });

  it('toutes les routes convergent vers une conclusion', () => {
    const ends = new Set(ERRORS.edges.filter((e) => e.to === 'outcome').map((e) => e.from));
    for (const id of ['route', 'notify-warning', 'notify-critical']) {
      expect(ends.has(id), `« ${id} » ne conclut pas`).toBe(true);
    }
  });

  it('un échec Slack ne fait pas disparaître l’incident', () => {
    for (const id of ['notify-warning', 'notify-critical']) {
      const ports = ERRORS.edges.filter((e) => e.from === id).map((e) => e.fromPort);
      expect(ports.sort(), id).toEqual(['error', 'main']);
    }
  });
});

describe('le pipeline complet', () => {
  it('chaîne les six workflows sans trou', () => {
    const calls = new Map<string, string[]>();
    for (const wf of ALL) {
      calls.set(
        wf.id,
        wf.nodes.filter((n) => n.type === 'subflow').map((n) => String(n.params.workflowId)),
      );
    }
    // 01 has TWO exits since tuning rules landed: the normal one to 02, and a
    // short circuit to 05 for an alert a rule closed. The second is what keeps
    // "closed by a rule" from meaning "silently dropped" — it still gets an
    // audit row, it simply never costs an enrichment or a model call.
    expect(calls.get('01-ingestion')?.sort()).toEqual(['02-enrichment', '05-audit-log']);
    expect(calls.get('02-enrichment')).toEqual(['03-ai-decision']);
    expect(calls.get('03-ai-decision')).toEqual(['04-action-routing']);
    expect(calls.get('04-action-routing')).toEqual(['05-audit-log']);
    expect(calls.get('05-audit-log')).toEqual([]);
    expect(calls.get('06-error-handler')).toEqual([]);
  });

  it('n’appelle aucun workflow qui n’existe pas', () => {
    const known = new Set(ALL.map((wf) => wf.id));
    for (const wf of ALL) {
      for (const node of wf.nodes.filter((n) => n.type === 'subflow')) {
        expect(known.has(String(node.params.workflowId)), `« ${node.id} »`).toBe(true);
      }
    }
  });

  it('stays far lighter than the 113 nodes it was ported from', () => {
    // 15 + 9 + 16 + 23 + 8 + 8. What went: 6 sticky notes, 3 no-ops, the
    // "Build Error Ctx" nodes and their calls, the copy-only `set` nodes, and
    // 06's second entry form.
    //
    // 01 went 11 → 15 with the tuning rules; 04 went 21 → 23 with the Slack
    // notification threshold (`notify?` and `below-threshold`). The per-workflow
    // breakdown is asserted, not just the total: a node added here and one lost
    // there would cancel out in a sum.
    const total = ALL.reduce((n, wf) => n + wf.nodes.length, 0);
    expect(total).toBe(79);
    expect(ALL.map((wf) => wf.nodes.length)).toEqual([15, 9, 16, 23, 8, 8]);
  });

  it('aucun identifiant de workflow en double', () => {
    expect(new Set(ALL.map((w) => w.id)).size).toBe(ALL.length);
  });
});
