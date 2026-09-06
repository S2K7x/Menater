/**
 * Tests des définitions de workflow 01 → 03.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT
 *
 * Une définition est de la DONNÉE : le compilateur vérifie ses types, pas sa
 * cohérence. Un lien vers un nœud supprimé, une branche d'erreur oubliée, un
 * `transform` désignant une fonction qui n'existe plus : rien de tout cela ne
 * se voit avant la première alerte.
 *
 * Ces tests relisent donc chaque graphe et vérifient ce que le compilateur ne
 * peut pas voir — y compris les invariants de sûreté que le portage ne doit
 * jamais avoir perdus en route.
 * ============================================================================
 */

import { describe, expect, it } from 'vitest';

import { assertAcyclic } from '../engine.ts';
import { NODE_EFFECTS, type WorkflowDef } from '../types.ts';
import { validateCondition, type Condition } from '../values.ts';
import { DECISION, ENRICHMENT, INGESTION, PIPELINE_WORKFLOWS } from './pipeline.ts';

const named = (wf: WorkflowDef) => `${wf.id}`;

describe.each(PIPELINE_WORKFLOWS.map((wf) => [named(wf), wf] as const))(
  'intégrité de %s',
  (_name, wf) => {
    it('n’a aucun lien vers un nœud inexistant', () => {
      const ids = new Set(wf.nodes.map((n) => n.id));
      for (const edge of wf.edges) {
        expect(ids.has(edge.from), `lien depuis « ${edge.from} » inconnu`).toBe(true);
        expect(ids.has(edge.to), `lien vers « ${edge.to} » inconnu`).toBe(true);
      }
    });

    it('n’a aucun identifiant de nœud en double', () => {
      // L'identifiant est le contrat : deux nœuds qui le partagent rendraient
      // le journal d'exécution ambigu.
      const ids = wf.nodes.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('n’a aucun nœud orphelin', () => {
      // Un nœud que rien n'atteint ne s'exécutera jamais. Il ne casse rien —
      // c'est bien le problème : il donne l'illusion d'une étape qui a lieu.
      const reached = new Set(wf.edges.map((e) => e.to));
      const orphans = wf.nodes
        .filter((n) => !n.type.startsWith('trigger.') && !reached.has(n.id))
        .map((n) => n.id);
      expect(orphans).toEqual([]);
    });

    it('a exactement un déclencheur', () => {
      expect(wf.nodes.filter((n) => n.type.startsWith('trigger.'))).toHaveLength(1);
    });

    it('n’a pas de cycle', () => {
      expect(() => assertAcyclic(wf)).not.toThrow();
    });

    it('a des conditions valides sur chaque `if`', () => {
      for (const node of wf.nodes.filter((n) => n.type === 'if')) {
        expect(() => validateCondition(node.params.condition as Condition), node.id).not.toThrow();
      }
    });

    it('a une sortie de repli sur chaque `switch`', () => {
      // Le piège n8n : sans repli, une valeur inattendue arrête le flux en
      // affichant « succès ».
      for (const node of wf.nodes.filter((n) => n.type === 'switch')) {
        expect(typeof node.params.fallbackPort, node.id).toBe('string');
      }
    });

    it('câble les deux ports de chaque `if`', () => {
      // Une branche non câblée n'est pas une erreur pour le moteur : le flux
      // s'y arrête simplement. C'est exactement ce qu'on ne veut pas découvrir
      // en production.
      //
      // On compare des ENSEMBLES, pas des listes : un port peut légitimement
      // mener à plusieurs nœuds — c'est le cas de `payload-ok` dans 02, qui
      // lance les trois sources d'enrichissement en parallèle.
      for (const node of wf.nodes.filter((n) => n.type === 'if')) {
        const ports = new Set(wf.edges.filter((e) => e.from === node.id).map((e) => e.fromPort));
        expect([...ports].sort(), `« ${node.id} »`).toEqual(['false', 'true']);
      }
    });
  },
);

describe('les appels externes ont une branche d’erreur ou un motif', () => {
  it.each(PIPELINE_WORKFLOWS.map((wf) => [named(wf), wf] as const))('%s', (_n, wf) => {
    // « Ne jamais throw une erreur silencieuse » : un appel externe qui échoue
    // sans branche d'erreur arrête l'exécution. C'est acceptable — le journal
    // le montre — mais ça doit être un CHOIX, pas un oubli.
    for (const node of wf.nodes) {
      if (NODE_EFFECTS[node.type] === 'pure') continue;
      if (node.type === 'subflow') continue;
      const hasError = wf.edges.some((e) => e.from === node.id && e.fromPort === 'error');
      const hasRetry = node.retry !== undefined;
      expect(hasError || hasRetry, `« ${node.id} » : ni branche d'erreur ni réessai`).toBe(true);
    }
  });
});

describe('01 — invariants de sûreté conservés au portage', () => {
  it('la déduplication a une branche d’erreur CÂBLÉE', () => {
    // LE DÉFAUT B2 : `alwaysOutputData` + `continueErrorOutput` faisaient
    // partir les deux branches en parallèle, et 01 répondait « accepted » sur
    // une déduplication échouée.
    const errorEdges = INGESTION.edges.filter((e) => e.from === 'dedup' && e.fromPort === 'error');
    expect(errorEdges).toHaveLength(1);
    expect(errorEdges[0].to).toBe('respond-500');
  });

  it('un doublon ne déclenche PAS la suite du pipeline', () => {
    // Seule la branche « accepté » mène à 02.
    const fromDuplicate = INGESTION.edges.filter((e) => e.from === 'respond-200');
    expect(fromDuplicate).toEqual([]);
  });

  it('chaque réponse porte un statut explicite, jamais un défaut', () => {
    // Sous n8n, `responseCode` vivait dans `options` : l'oublier faisait
    // répondre 200 y compris aux rejets de schéma.
    const codes = INGESTION.nodes
      .filter((n) => n.type === 'respond')
      .map((n) => n.params.status);
    expect(codes).toEqual([400, 500, 200, 202]);
  });

  it('passe à 02 un payload explicite, jamais rien', () => {
    // Le piège `mode: "once"` : le sous-workflow démarrait à zéro item et se
    // terminait en « succès » sans rien exécuter.
    const node = INGESTION.nodes.find((n) => n.id === 'to-enrichment');
    expect(node?.params.input).toBeDefined();
  });
});

describe('02 — les trois sources sont indépendantes', () => {
  it('chacune est atteinte directement depuis le garde', () => {
    // L'échec de l'une n'empêche jamais les autres : elles ne sont pas en
    // chaîne. Sous n8n, un enrichissement en série perdait les suivants.
    for (const source of ['shodan', 'abuseipdb', 'virustotal']) {
      const from = ENRICHMENT.edges.filter((e) => e.to === source);
      expect(from.map((e) => e.from), source).toEqual(['payload-ok']);
    }
  });

  it('chacune rejoint l’assemblage par ses DEUX ports', () => {
    // Un échec doit atteindre l'assemblage pour y devenir « unavailable ».
    // Sans le lien `error`, une source en panne ferait disparaître la branche.
    for (const source of ['shodan', 'abuseipdb', 'virustotal']) {
      const ports = ENRICHMENT.edges
        .filter((e) => e.from === source && e.to === 'assemble')
        .map((e) => e.fromPort);
      expect(ports.sort(), source).toEqual(['error', 'main']);
    }
  });
});

describe('03 — aucune alerte ne se perd', () => {
  it('les deux appels au modèle ont un repli sur erreur', () => {
    for (const node of ['model', 'model-retry']) {
      const target = DECISION.edges.find((e) => e.from === node && e.fromPort === 'error')?.to;
      expect(target, node).toBe('fallback-api');
    }
  });

  it('un échec de validation après deux tentatives tombe sur un repli', () => {
    const target = DECISION.edges.find((e) => e.from === 'valid-retry' && e.fromPort === 'false')?.to;
    expect(target).toBe('fallback-schema');
  });

  it('TOUS les chemins convergent vers la dernière barrière', () => {
    // L'invariant central de 03 : aucune décision ne sort du workflow sans
    // être passée par `finalize`. Un chemin qui l'éviterait produirait une
    // décision non plafonnée, sans shadow_mode, et sans trace des corrections.
    const producers = ['valid', 'valid-retry', 'fallback-schema', 'fallback-api'];
    for (const node of producers) {
      const reaches = DECISION.edges.some((e) => e.from === node && e.to === 'finalize');
      expect(reaches, `« ${node} » n'atteint pas finalize`).toBe(true);
    }
    // Et rien ne part vers 04 sans passer par elle.
    const toRouting = DECISION.edges.filter((e) => e.to === 'to-routing');
    expect(toRouting.map((e) => e.from)).toEqual(['finalize']);
  });

  it('le modèle exige les cinq clés, sur les deux tentatives', () => {
    for (const id of ['model', 'model-retry']) {
      const node = DECISION.nodes.find((n) => n.id === id);
      expect(node?.params.requiredKeys, id).toEqual([
        'verdict', 'confidence', 'reasoning', 'recommended_action', 'data_lineage',
      ]);
    }
  });
});

describe('le portage a bien retiré la plomberie n8n', () => {
  it('reste plus léger que les 54 nœuds n8n, réglage compris', () => {
    const total = PIPELINE_WORKFLOWS.reduce((n, wf) => n + wf.nodes.length, 0);
    // 6 stickyNote + 3 noOp + 6 « Build Error Ctx » et leurs appels + les
    // recopies de champs. Rien de fonctionnel n'a disparu.
    //
    // 36 au portage, 40 depuis les règles de réglage : `rules-load`, `tuning`,
    // `tuned-out` et la sortie vers l'audit. Le chiffre est vérifié plutôt que
    // borné parce qu'un nœud qui apparaît sans qu'on l'ait voulu est
    // exactement ce que ce test existe pour attraper.
    expect(total).toBeLessThan(54);
    expect(total).toBe(40);
  });

  it('ne désigne les crédentiales que par leur NOM', () => {
    // Une définition est lue, éditée, versionnée, affichée. Un secret y serait
    // exposé à chacune de ces étapes. Ce qu'on vérifie n'est donc pas
    // l'absence du mot « secret » — il DOIT s'y trouver, comme référence —
    // mais que sa valeur est un nom court et connu, jamais une clé.
    const KNOWN = ['shodan.apiKey', 'abuseipdb.apiKey', 'virustotal.apiKey',
      'openrouter.apiKey', 'slack.botToken'];
    for (const wf of PIPELINE_WORKFLOWS) {
      for (const node of wf.nodes) {
        const auth = node.params.authHeader as { secret?: string } | undefined;
        if (auth?.secret) expect(KNOWN, `« ${node.id} »`).toContain(auth.secret);
      }
    }
  });

  it('ne contient aucune valeur qui RESSEMBLE à une clé', () => {
    // Les préfixes que portent les clés réelles des fournisseurs utilisés ici.
    const looksLikeAKey = /\b(sk-[a-z0-9-]{10,}|xox[baprs]-[a-z0-9-]{10,})/i;
    for (const wf of PIPELINE_WORKFLOWS) {
      expect(looksLikeAKey.test(JSON.stringify(wf.nodes)), wf.id).toBe(false);
    }
  });

  it('les nœuds portent une note explicative là où le comportement surprend', () => {
    // Elle remplace les `stickyNote` du canevas — versionnée avec le graphe,
    // et affichée dans l'onglet Workflow au-dessus du formulaire.
    const noted = PIPELINE_WORKFLOWS.flatMap((wf) => wf.nodes).filter((n) => n.note);
    expect(noted.length).toBeGreaterThanOrEqual(6);
  });
});

describe('deduplication is race-safe by construction', () => {
  it('decides in the index with ON CONFLICT, never with WHERE NOT EXISTS', () => {
    // `WHERE NOT EXISTS` reads as atomic inside one statement and is not: two
    // concurrent transactions both see the row absent, both insert, and one
    // dies on a unique violation. Measured against the real database: twelve
    // simultaneous sends of one alert_id produced a 500, which tells the sender
    // to retry an alert that was already accepted.
    const dedup = INGESTION.nodes.find((n) => n.id === 'dedup')!;
    const sql = String(dedup.params.sql);
    expect(sql).toMatch(/ON CONFLICT \(alert_id\) DO NOTHING/);
    expect(sql).not.toMatch(/WHERE NOT EXISTS/);
  });

  it('always returns exactly one row, so an empty answer still means "no answer"', () => {
    // The other guarantee this query carries: `interpretDedup` refuses to
    // conclude on an empty result rather than assuming the alert is new. That
    // only holds while a healthy query cannot itself return zero rows.
    const dedup = INGESTION.nodes.find((n) => n.id === 'dedup')!;
    const sql = String(dedup.params.sql);
    expect(sql).toMatch(/SELECT NOT EXISTS \(SELECT 1 FROM inserted\) AS is_duplicate/);
  });
});
