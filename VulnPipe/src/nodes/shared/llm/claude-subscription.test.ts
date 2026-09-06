/**
 * Tests du fournisseur « abonnement Claude ».
 *
 * Aucun appel réseau, aucune consommation d'abonnement : le `query` du SDK est
 * injecté. La suite doit rester rapide et hors ligne (règle du dépôt).
 *
 * Le test qui compte le plus est celui de la FACTURATION SILENCIEUSE : si une
 * clé API prend le pas sur la session Claude Code, la personne paie à l'appel
 * en croyant consommer son abonnement. Un outil qui laisse passer ça sans rien
 * dire fait exactement ce que ce dépôt s'interdit — une surprise déguisée en
 * succès.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  ClaudeSubscriptionClient,
  SUBSCRIPTION_KEY_SOURCE,
  extractJson,
  schemaInstruction,
  type AgentSdkMessage,
  type AgentSdkQuery,
} from './claude-subscription.ts';
import { claudeCodeInstalled, describeProviders, createLlmClient, parseEffort } from './factory.ts';
import { LlmError, type JsonSchema } from './types.ts';

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    confidence_score: { type: 'number' },
  },
  required: ['verdict', 'confidence_score'],
};

/**
 * Faux flux du SDK, calqué sur le sondage réel du 2026-08-19
 * (`@anthropic-ai/claude-agent-sdk` 0.3.235) : un `system/init` porteur
 * d'`apiKeySource`, puis un `result`.
 */
function fakeQuery(over: { apiKeySource?: string; result?: string; isError?: boolean } = {}) {
  const messages: AgentSdkMessage[] = [
    {
      type: 'system',
      subtype: 'init',
      apiKeySource: over.apiKeySource ?? SUBSCRIPTION_KEY_SOURCE,
      model: 'claude-sonnet-5',
    },
    {
      type: 'result',
      subtype: over.isError === true ? 'error' : 'success',
      is_error: over.isError ?? false,
      result: over.result ?? '{"verdict":"confirmed","confidence_score":0.9}',
      total_cost_usd: 0.0458,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 6462,
        cache_read_input_tokens: 19973,
        output_tokens: 8,
        output_tokens_details: { thinking_tokens: 0 },
      },
    },
  ];
  // Le faux prend explicitement les arguments du vrai `query` : sans ça,
  // `mock.calls[0]` est typé comme un tuple vide et les assertions sur les
  // options passées au SDK ne compilent pas.
  return vi.fn(async function* (_args: Parameters<AgentSdkQuery>[0]) {
    for (const m of messages) yield m;
  });
}

const REQUEST = { system: 'Tu arbitres.', user: 'Cette route est-elle vulnérable ?', schema: SCHEMA };

// ===========================================================================
// Le chemin nominal
// ===========================================================================

describe('Abonnement Claude — appel', () => {
  it('rend un verdict parsé, sans clé API', async () => {
    const client = new ClaudeSubscriptionClient({ query: fakeQuery() as never });
    const response = await client.complete<{ verdict: string; confidence_score: number }>(REQUEST);

    expect(response.parsed.verdict).toBe('confirmed');
    expect(response.parsed.confidence_score).toBe(0.9);
    expect(response.provider).toBe('claude-subscription');
    expect(response.model).toBe('claude-sonnet-5');
  });

  it("ne déclare AUCUN coût en dollars — l'abonnement n'est pas facturé à l'appel", async () => {
    // Le SDK renvoie `total_cost_usd` : c'est l'ÉQUIVALENT au tarif API, pas
    // une somme débitée. Le remonter comme un coût réel afficherait à
    // l'utilisateur une dépense qui n'a jamais eu lieu.
    const client = new ClaudeSubscriptionClient({ query: fakeQuery() as never });
    const response = await client.complete(REQUEST);

    expect(response.usage.cost_usd).toBe(0);
    // L'équivalent reste visible, mais clairement étiqueté comme tel.
    expect(response.usage.upstream_provider).toContain('abonnement Claude');
    expect(response.usage.upstream_provider).toContain('équivalent API');
  });

  it('compte tout le contexte transporté, y compris le cache', async () => {
    // ~26 000 jetons de harnais Claude Code par appel : les cacher ferait
    // croire à un appel à 2 jetons d'entrée. C'est ce volume qui décide si le
    // quota d'abonnement tient sur un scan.
    const client = new ClaudeSubscriptionClient({ query: fakeQuery() as never });
    const response = await client.complete(REQUEST);

    expect(response.usage.input_tokens).toBe(2 + 6462 + 19973);
    expect(response.usage.output_tokens).toBe(8);
  });
});

// ===========================================================================
// LE test : la facturation silencieuse
// ===========================================================================

describe('Facturation', () => {
  it('AVERTIT quand une clé API a pris le pas sur l abonnement', async () => {
    // `apiKeySource` ≠ "none" : la session Claude Code a perdu, la personne
    // paie à l'appel sans le savoir.
    const warnings: string[] = [];
    const client = new ClaudeSubscriptionClient({
      query: fakeQuery({ apiKeySource: 'ANTHROPIC_API_KEY' }) as never,
      onWarning: (m) => warnings.push(m),
    });

    await client.complete(REQUEST);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("n'a PAS été facturé sur ton abonnement");
    expect(warnings[0]).toContain('ANTHROPIC_API_KEY');
  });

  it("n avertit pas quand c est bien l abonnement qui paie", async () => {
    const warnings: string[] = [];
    const client = new ClaudeSubscriptionClient({
      query: fakeQuery({ apiKeySource: SUBSCRIPTION_KEY_SOURCE }) as never,
      onWarning: (m) => warnings.push(m),
    });

    await client.complete(REQUEST);
    expect(warnings).toEqual([]);
  });
});

// ===========================================================================
// Sorties imparfaites et pannes
// ===========================================================================

describe('Robustesse', () => {
  it('accepte un JSON entouré d un bloc de code', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('accepte un JSON précédé ou suivi d une phrase', () => {
    expect(extractJson('Voici le verdict : {"a":1} — voilà.')).toEqual({ a: 1 });
  });

  it('échoue franchement quand il n y a pas de JSON du tout', () => {
    // Mieux vaut une erreur nette qu'un verdict deviné.
    expect(() => extractJson('Je ne peux pas répondre.')).toThrow(LlmError);
    try {
      extractJson('Je ne peux pas répondre.');
    } catch (error) {
      expect((error as LlmError).kind).toBe('bad_output');
      expect((error as LlmError).retryable).toBe(false);
    }
  });

  it('traite une limite d abonnement atteinte comme transitoire', async () => {
    // `attempts: 1` : on vérifie la QUALIFICATION de l'erreur, pas la reprise
    // (testée dans `master.test.ts`). Sans ça le test attendrait les vraies
    // temporisations pour rien.
    const client = new ClaudeSubscriptionClient({
      query: fakeQuery({ isError: true, result: 'Usage limit reached, resets at 14:00' }) as never,
      retry: { attempts: 1 },
    });

    await expect(client.complete(REQUEST)).rejects.toMatchObject({
      kind: 'rate_limit',
      retryable: true,
    });
  });

  it('signale une absence de résultat au lieu de rendre un verdict vide', async () => {
    // Un flux qui se termine sans `result` est une panne, pas un « rien à
    // signaler ».
    const empty = vi.fn(async function* (_args: Parameters<AgentSdkQuery>[0]) {
      yield { type: 'system', subtype: 'init', apiKeySource: 'none' } as AgentSdkMessage;
    });
    const client = new ClaudeSubscriptionClient({ query: empty as never, retry: { attempts: 1 } });

    await expect(client.complete(REQUEST)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('la consigne de format nomme les clés attendues', () => {
    const instruction = schemaInstruction(SCHEMA);
    expect(instruction).toContain('verdict');
    expect(instruction).toContain('confidence_score');
    expect(instruction).toContain('JSON');
  });
});

// ===========================================================================
// Profondeur de réflexion
// ===========================================================================

describe('Niveau d effort', () => {
  it("transmet le niveau choisi au SDK", async () => {
    const query = fakeQuery();
    const client = new ClaudeSubscriptionClient({ query: query as never, effort: 'low' });
    await client.complete(REQUEST);

    expect(query.mock.calls[0]![0].options.effort).toBe('low');
  });

  it("ne force RIEN quand l utilisateur n a pas choisi", async () => {
    // Le défaut du modèle vaut mieux qu'une valeur qu'on aurait inventée à sa
    // place : on n'envoie pas la clé du tout.
    const query = fakeQuery();
    const client = new ClaudeSubscriptionClient({ query: query as never });
    await client.complete(REQUEST);

    expect(query.mock.calls[0]![0].options).not.toHaveProperty('effort');
  });

  it('accepte les cinq niveaux et rejette le reste', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(parseEffort(level)).toBe(level);
    }
    expect(parseEffort('HIGH')).toBe('high'); // tolérant à la casse
    expect(parseEffort('turbo')).toBeUndefined();
    expect(parseEffort(undefined)).toBeUndefined();
    expect(parseEffort('')).toBeUndefined();
  });

  it('se construit depuis la variable d environnement', () => {
    const client = createLlmClient({
      VULNPIPE_LLM_PROVIDER: 'claude-subscription',
      VULNPIPE_LLM_EFFORT: 'max',
    });
    expect(client.provider).toBe('claude-subscription');
  });
});

// ===========================================================================
// Disponibilité annoncée à l'utilisateur
// ===========================================================================

describe('Disponibilité', () => {
  it('détecte Claude Code par le PATH', () => {
    expect(claudeCodeInstalled({ PATH: '/nulle/part' })).toBe(false);
    expect(claudeCodeInstalled({})).toBe(false);
  });

  it('dit quoi faire quand Claude Code est absent', () => {
    const entry = describeProviders({ PATH: '/nulle/part' } as never).find(
      (p) => p.id === 'claude-subscription'
    );
    expect(entry!.available).toBe(false);
    expect(entry!.why).toMatch(/Claude Code/);
  });

  it("REFUSE d annoncer « abonnement » quand une clé API l emporterait", () => {
    // Le fournisseur marcherait, mais il ne ferait pas ce que son nom promet :
    // annoncer « prêt » ferait payer quelqu'un qui croit ne rien payer.
    const entry = describeProviders({
      PATH: '/nulle/part',
      ANTHROPIC_API_KEY: 'sk-ant-xxx',
    } as never).find((p) => p.id === 'claude-subscription');

    expect(entry!.available).toBe(false);
  });

  it('se construit sans aucune clé', () => {
    const client = createLlmClient({ VULNPIPE_LLM_PROVIDER: 'claude-subscription' });
    expect(client.provider).toBe('claude-subscription');
  });
});
