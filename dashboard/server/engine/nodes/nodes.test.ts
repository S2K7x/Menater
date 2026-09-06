/**
 * Tests du catalogue de nœuds.
 *
 * ============================================================================
 * CE QU'ILS PROTÈGENT
 *
 * Chaque nœud de ce catalogue remplace un nœud n8n qui a coûté du temps à
 * quelqu'un. Les tests ci-dessous rejouent ces pannes précises et vérifient
 * qu'elles sont devenues impossibles :
 *
 *   - le Switch sans sortie de repli, qui arrêtait le flux en affichant
 *     « succès » ;
 *   - le `responseCode` enfoui dans `options`, qui faisait répondre 200 à tout,
 *     y compris aux rejets de schéma ;
 *   - `mode: "once"` sur un Execute Workflow, qui démarrait le sous-workflow
 *     avec zéro item — 8 occurrences historiques sur cette instance ;
 *   - Slack qui répond HTTP 200 avec `ok: false`.
 *
 * Et deux règles propres à ce moteur : aucun code n'est exécuté depuis une
 * définition, aucun secret n'y figure.
 * ============================================================================
 */

import { describe, expect, it, vi } from 'vitest';

import type { NodeContext } from '../engine.ts';
import type { NodeDef, NodeType } from '../types.ts';
import { TransformRegistry, pureHandlers, type PureDeps } from './pure.ts';
import { ioHandlers, type IoDeps } from './io.ts';
import { controlHandlers, type ControlDeps } from './control.ts';

const FIXED_NOW = new Date('2026-08-24T10:00:00.000Z');

function deps(over: Partial<IoDeps & ControlDeps> = {}): IoDeps & ControlDeps {
  return {
    transforms: new TransformRegistry(),
    vars: () => new Map(),
    now: () => FIXED_NOW,
    secret: () => undefined,
    ...over,
  };
}

function ctx(
  type: NodeType,
  params: Record<string, unknown>,
  input: unknown = {},
  outputs: Map<string, unknown> = new Map(),
): NodeContext {
  const node: NodeDef = { id: 'n1', type, label: 'peu importe', params, position: { x: 0, y: 0 } };
  return {
    runId: 'run-1',
    workflow: { id: 'wf', name: 'test', version: 1, nodes: [node], edges: [] },
    node,
    input,
    outputs,
    alertId: 'A-1',
  };
}

describe('transform — le code vit dans TypeScript, pas dans la définition', () => {
  it('appelle une fonction enregistrée', async () => {
    const registry = new TransformRegistry().register('doubler', (input) => ({
      n: (input as { n: number }).n * 2,
    }));
    const h = pureHandlers(deps({ transforms: registry }) as PureDeps);
    const out = await h.transform(ctx('transform', { fn: 'doubler' }, { n: 21 }));
    expect(out.output).toEqual({ n: 42 });
  });

  it("transmet l'identifiant de l'exécution EN COURS à la transformation", async () => {
    // Il venait d'une variable de module que personne n'affectait jamais : les
    // transformations recevaient `''`. La ligne d'audit partait donc sans
    // `run_id` — la chaîne hachée perdait son lien vers l'exécution — et le
    // lien d'approbation Slack ne désignait aucun run.
    //
    // Aucun test ne pouvait l'attraper : ils construisaient le registre en
    // fournissant eux-mêmes `runId: () => 'run-1'`, c'est-à-dire exactement la
    // valeur que le câblage de production omettait. Celui-ci lit ce que le
    // NŒUD a reçu, donc ce qu'une vraie exécution transmet.
    const seen: string[] = [];
    const registry = new TransformRegistry().register('espion', (_input, _vars, run) => {
      seen.push(run.runId);
      return {};
    });
    const h = pureHandlers(deps({ transforms: registry }) as PureDeps);
    await h.transform(ctx('transform', { fn: 'espion' }));
    expect(seen).toEqual(['run-1']);
  });

  it("le transmet aussi sur un nœud de jonction", async () => {
    // La jonction passe par une autre branche de `makeTransform` : elle avait
    // sa propre ligne d'appel, donc son propre oubli possible.
    const seen: string[] = [];
    const registry = new TransformRegistry().register('espion', (_input, _vars, run) => {
      seen.push(run.runId);
      return {};
    });
    const h = pureHandlers(deps({ transforms: registry }) as PureDeps);
    await h.transform(
      ctx('transform', {
        fn: 'espion',
        inputs: { a: { kind: 'const', value: 1 } },
      }),
    );
    expect(seen).toEqual(['run-1']);
  });

  it('nomme la fonction manquante ET liste celles qui existent', async () => {
    // Un « transformation inconnue » nu enverrait fouiller le code source.
    const registry = new TransformRegistry().register('valider', (i) => i);
    const h = pureHandlers(deps({ transforms: registry }) as PureDeps);
    await expect(h.transform(ctx('transform', { fn: 'faute-de-frappe' })))
      .rejects.toThrow(/faute-de-frappe.*valider/s);
  });

  it('n’exécute aucun code fourni en paramètre', async () => {
    // Le paramètre est un NOM, jamais une source. Une définition de workflow
    // est de la donnée éditable ; elle ne doit pas pouvoir devenir du code.
    const h = pureHandlers(deps() as PureDeps);
    await expect(h.transform(ctx('transform', { fn: 'return process.exit(1)' })))
      .rejects.toThrow(/Unknown transform/);
  });
});

describe('set', () => {
  it('fusionne par défaut, remplace sur demande', async () => {
    const h = pureHandlers(deps() as PureDeps);
    const assignments = [{ key: 'b', value: { kind: 'const' as const, value: 2 } }];

    const merged = await h.set(ctx('set', { assignments }, { a: 1 }));
    expect(merged.output).toEqual({ a: 1, b: 2 });

    const replaced = await h.set(ctx('set', { assignments, mode: 'replace' }, { a: 1 }));
    expect(replaced.output).toEqual({ b: 2 });
  });

  it('pose l’horodatage et l’identifiant d’exécution — ce que faisaient $now et $execution.id', async () => {
    const h = pureHandlers(deps() as PureDeps);
    const out = await h.set(
      ctx('set', {
        assignments: [
          { key: 'at', value: { kind: 'ctx', field: 'now' } },
          { key: 'run', value: { kind: 'ctx', field: 'runId' } },
        ],
      }),
    );
    expect(out.output).toEqual({ at: FIXED_NOW.toISOString(), run: 'run-1' });
  });
});

describe('if', () => {
  it('emprunte le port true ou false, et laisse passer l’entrée', async () => {
    const h = pureHandlers(deps() as PureDeps);
    const params = { condition: { left: { kind: 'input', path: 'ok' }, op: 'isTrue' } };

    const yes = await h.if(ctx('if', params, { ok: true, garde: 1 }));
    expect(yes.port).toBe('true');
    // Un `if` teste, il ne transforme pas : l'aval reçoit l'entrée intacte.
    expect(yes.output).toEqual({ ok: true, garde: 1 });

    expect((await h.if(ctx('if', params, { ok: false }))).port).toBe('false');
  });
});

describe('switch — le piège de la sortie de repli, rendu impossible', () => {
  const cases = [
    { port: 'critique', when: { left: { kind: 'input', path: 'sev' }, op: 'eq', right: { kind: 'const', value: 'critical' } } },
  ];

  it('prend le premier cas qui correspond', async () => {
    const h = pureHandlers(deps() as PureDeps);
    const out = await h.switch(ctx('switch', { cases, fallbackPort: 'autre' }, { sev: 'critical' }));
    expect(out.port).toBe('critique');
  });

  it('prend le repli quand rien ne correspond — au lieu de s’arrêter en « succès »', async () => {
    const h = pureHandlers(deps() as PureDeps);
    const out = await h.switch(ctx('switch', { cases, fallbackPort: 'autre' }, { sev: 'low' }));
    expect(out.port).toBe('autre');
  });

  it('REFUSE de s’exécuter sans sortie de repli', async () => {
    // Sous n8n, ce switch-là sortait zéro item sur toutes ses sorties et le
    // flux s'arrêtait en affichant `success`. Ici il ne démarre pas.
    const h = pureHandlers(deps() as PureDeps);
    await expect(h.switch(ctx('switch', { cases }, { sev: 'low' })))
      .rejects.toThrow(/sortie de repli/);
  });
});

describe('respond — le code de statut est de premier rang', () => {
  it('porte le statut demandé', async () => {
    // Sous n8n, `responseCode` vivait dans `options` : l'oublier faisait
    // répondre 200 à tout, y compris aux rejets de schéma.
    const h = pureHandlers(deps() as PureDeps);
    const out = await h.respond(ctx('respond', { status: 400 }, { errors: ['x'] }));
    expect(out.output).toMatchObject({ status: 400, body: { errors: ['x'] } });
  });

  it('refuse un statut absent plutôt que de supposer 200', async () => {
    const h = pureHandlers(deps() as PureDeps);
    await expect(h.respond(ctx('respond', {}))).rejects.toThrow(/status/);
  });
});

describe('merge — par identifiant, pas par ordre d’arrivée', () => {
  it('fusionne les sorties nommées', async () => {
    const h = pureHandlers(deps() as PureDeps);
    const outputs = new Map<string, unknown>([['a', { x: 1 }], ['b', { y: 2 }]]);
    const out = await h.merge(ctx('merge', { sources: ['a', 'b'] }, {}, outputs));
    // Réordonner les liens ne peut pas intervertir les données : elles sont
    // désignées par identifiant.
    expect(out.output).toEqual({ x: 1, y: 2 });
  });
});

describe('http', () => {
  it('sort par le port error sur un statut non-2xx, sans lever', async () => {
    const fetchMock = vi.fn(async () => new Response('{"boom":1}', { status: 503 }));
    const h = ioHandlers(deps({ fetch: fetchMock as never }));
    const out = await h.http(ctx('http', { url: { kind: 'const', value: 'https://x.test' } }));
    // Une branche d'erreur câblée peut alors rattraper — sans que le nœud
    // n'ait eu à throw, donc sans échec silencieux possible.
    expect(out.port).toBe('error');
    expect(out.output).toMatchObject({ status: 503 });
  });

  it('NOMME la crédentiale absente au lieu de partir chercher un 401', async () => {
    const fetchMock = vi.fn();
    const h = ioHandlers(deps({ fetch: fetchMock as never }));
    await expect(
      h.http(
        ctx('http', {
          url: { kind: 'const', value: 'https://x.test' },
          authHeader: { header: 'Key', secret: 'abuseipdb.key' },
        }),
      ),
    ).rejects.toThrow(/abuseipdb\.key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('n’expose aucun secret dans la définition du nœud', async () => {
    const seen: RequestInit[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response('{}', { status: 200 });
    });
    const h = ioHandlers(deps({ fetch: fetchMock as never, secret: () => 'CLE-SECRETE' }));
    const node = ctx('http', {
      url: { kind: 'const', value: 'https://x.test' },
      authHeader: { header: 'Key', secret: 'abuseipdb.key' },
    });
    await h.http(node);

    // La définition ne porte que le NOM de la crédentiale. C'est elle qui est
    // versionnée, éditée dans l'interface et affichée.
    expect(JSON.stringify(node.node.params)).not.toContain('CLE-SECRETE');
    expect(seen[0].headers).toMatchObject({ Key: 'CLE-SECRETE' });
  });
});

describe('postgres — les valeurs ne sont jamais interpolées', () => {
  it('passe le SQL et les paramètres séparément', async () => {
    const query = vi.fn(async () => [{ id: 1 }]);
    const h = ioHandlers(deps({ query }));
    await h.postgres(
      ctx(
        'postgres',
        { sql: 'SELECT 1 FROM t WHERE alert_id = $1', params: [{ kind: 'input', path: 'id' }] },
        { id: "'; DROP TABLE soc_audit_log; --" },
      ),
    );
    // Une alerte contient par nature du texte fourni par un attaquant. Le SQL
    // reste une constante ; la charge voyage à part.
    expect(query).toHaveBeenCalledWith(
      'SELECT 1 FROM t WHERE alert_id = $1',
      ["'; DROP TABLE soc_audit_log; --"],
    );
  });

  it('dit qu’aucune base n’est configurée, au lieu d’échouer obscurément', async () => {
    const h = ioHandlers(deps());
    await expect(h.postgres(ctx('postgres', { sql: 'SELECT 1' })))
      .rejects.toThrow(/Settings/);
  });
});

describe('slack — un 200 n’est pas un succès', () => {
  it('échoue sur ok:false malgré un HTTP 200', async () => {
    // L'API Slack répond 200 avec `ok: false`. Se fier au code HTTP ferait
    // passer pour envoyée une demande d'approbation jamais postée — et
    // l'exécution attendrait la réponse à une question jamais posée.
    const fetchMock = vi.fn(
      async () => new Response('{"ok":false,"error":"channel_not_found"}', { status: 200 }),
    );
    const h = ioHandlers(deps({ fetch: fetchMock as never, secret: () => 'xoxb-test' }));
    await expect(
      h.notify(
        ctx('notify', {
          channel: { kind: 'const', value: '#soc-approvals' },
          text: { kind: 'const', value: 'coucou' },
        }),
      ),
    ).rejects.toThrow(/channel_not_found/);
  });

  it('pose une échéance : un Slack qui ne répond jamais ne fige pas le run', async () => {
    // Ce nœud poste la demande d'approbation. Sans échéance, un Slack qui
    // accepte la connexion sans répondre laisse l'exécution attendre la réponse
    // à une question jamais posée — l'inverse exact de « le silence n'est
    // jamais un consentement ».
    vi.useFakeTimers();
    try {
      const hanging = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );
      const h = ioHandlers(deps({ fetch: hanging as never, secret: () => 'xoxb-test' }));
      const pending = h.notify(
        ctx('notify', {
          channel: { kind: 'const', value: '#soc-approvals' },
          text: { kind: 'const', value: 'coucou' },
        }),
      );
      const settled = expect(pending).rejects.toThrow(/abort/i);
      await vi.advanceTimersByTimeAsync(11_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('llm — une décision incomplète est refusée', () => {
  const answer = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

  it('refuse une réponse à laquelle il manque une clé', async () => {
    // Inventer un verdict absent, c'est combler un trou par une valeur par
    // défaut — sur la donnée qui décide d'isoler une machine.
    const fetchMock = vi.fn(async () => answer('{"verdict":"true_positive"}'));
    const h = ioHandlers(deps({ fetch: fetchMock as never, secret: () => 'sk-test' }));
    await expect(
      h.llm(
        ctx('llm', {
          model: { kind: 'const', value: 'm' },
          prompt: { kind: 'const', value: 'p' },
          requiredKeys: ['verdict', 'confidence'],
        }),
      ),
    ).rejects.toThrow(/confidence/);
  });

  it('accepte une réponse complète et remonte la consommation', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"verdict":"false_positive","confidence":0.9}' } }],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }),
          { status: 200 },
        ),
    );
    const h = ioHandlers(deps({ fetch: fetchMock as never, secret: () => 'sk-test' }));
    const out = await h.llm(
      ctx('llm', {
        model: { kind: 'const', value: 'm' },
        prompt: { kind: 'const', value: 'p' },
        requiredKeys: ['verdict', 'confidence'],
      }),
    );
    expect(out.output).toMatchObject({
      decision: { verdict: 'false_positive', confidence: 0.9 },
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  });

  it('refuse une réponse qui n’est pas du JSON', async () => {
    const fetchMock = vi.fn(async () => answer('je suis désolé, je ne peux pas'));
    const h = ioHandlers(deps({ fetch: fetchMock as never, secret: () => 'sk-test' }));
    await expect(
      h.llm(ctx('llm', { model: { kind: 'const', value: 'm' }, prompt: { kind: 'const', value: 'p' } })),
    ).rejects.toThrow(/JSON/);
  });
});

describe('wait', () => {
  it('suspend avec le délai porté par une VARIABLE, donc éditable', async () => {
    const h = controlHandlers(
      deps({ vars: () => new Map([['approval.timeoutMinutes', 30]]), newToken: () => 'jeton-1' }),
    );
    const out = await h.wait(
      ctx('wait', { timeoutMinutes: { kind: 'var', key: 'approval.timeoutMinutes' } }),
    );
    expect(out.suspend).toEqual({ token: 'jeton-1', deadlineMs: 30 * 60_000 });
  });

  it('REFUSE un délai invalide au lieu d’attendre pour toujours ou pas du tout', async () => {
    const h = controlHandlers(deps({ vars: () => new Map([['t', 0]]) }));
    await expect(h.wait(ctx('wait', { timeoutMinutes: { kind: 'var', key: 't' } })))
      .rejects.toThrow(/invalid timeout/);
  });
});

describe('subflow — le piège de mode:"once"', () => {
  it('transmet l’entrée au sous-workflow', async () => {
    const run = vi.fn(async () => ({ done: true }));
    const h = controlHandlers(deps({ runSubflow: run }));
    const out = await h.subflow(ctx('subflow', { workflowId: '02-enrichment' }, { alert_id: 'A-1' }));
    expect(run).toHaveBeenCalledWith('02-enrichment', { alert_id: 'A-1' }, 'A-1');
    expect(out.output).toEqual({ done: true });
  });

  it('REFUSE de démarrer un sous-workflow à vide', async () => {
    // 8 occurrences historiques sur cette instance : le sous-workflow se
    // terminait en `success` sans rien exécuter.
    const run = vi.fn();
    const h = controlHandlers(deps({ runSubflow: run as never }));
    await expect(h.subflow(ctx('subflow', { workflowId: '02' }, null)))
      .rejects.toThrow(/nothing to hand to|started empty/);
    expect(run).not.toHaveBeenCalled();
  });
});
