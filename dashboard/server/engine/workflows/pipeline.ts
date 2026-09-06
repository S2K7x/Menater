/**
 * Définitions des workflows 01 → 03.
 *
 * ============================================================================
 * CE QUE LE PORTAGE A RETIRÉ
 *
 * n8n : 15 + 18 + 21 = 54 nœuds. Ici : 36. Rien de fonctionnel n'a disparu —
 * ce qui est parti n'existait que pour n8n :
 *
 *   - 6 `stickyNote` : de la documentation dessinée sur le canevas. Elle vit
 *     maintenant dans les en-têtes de fichiers, où elle est versionnée avec le
 *     code qu'elle décrit et où personne ne peut la déplacer par mégarde.
 *
 *   - 3 `noOp` : de la plomberie de branchement, sans objet ici.
 *
 *   - 6 nœuds « Build Error Ctx » + leurs appels au gestionnaire d'erreurs.
 *     Ils reconstruisaient À LA MAIN ce que n8n ne portait pas : quel
 *     workflow, quelle étape, quel message. Le journal d'exécution le sait
 *     déjà — identifiant du nœud, port emprunté, erreur, horodatage. On ne
 *     recopie plus une information qu'on possède.
 *
 *   - les nœuds `set` de recopie de champs, absorbés par les transformations
 *     typées qui les entouraient.
 *
 * ============================================================================
 * CE QUI A ÉTÉ AJOUTÉ, ET QUI N'EXISTAIT PAS
 *
 * Les branches `error` sont désormais CÂBLÉES et non plus implicites. Sous
 * n8n, `onError: continueErrorOutput` combiné à `alwaysOutputData` émettait un
 * item vide sur la sortie principale EN PLUS de l'erreur : les deux branches
 * partaient en parallèle, et 01 répondait « accepted » sur une déduplication
 * échouée. Ici un nœud sort par UN port, jamais deux.
 * ============================================================================
 */

import type { WorkflowDef } from '../types.ts';

/** Raccourcis de lecture — les définitions sont déjà assez verbeuses. */
const constant = (value: unknown) => ({ kind: 'const' as const, value });
const fromInput = (path: string) => ({ kind: 'input' as const, path });
const fromNode = (nodeId: string, path: string) => ({ kind: 'node' as const, nodeId, path });
const fromVar = (key: string) => ({ kind: 'var' as const, key });

/** Un lien. `main` par défaut, comme partout ailleurs. */
const link = (from: string, to: string, fromPort = 'main') => ({ from, fromPort, to });

// =============================================================================
// 01 — INGESTION
// =============================================================================

export const INGESTION: WorkflowDef = {
  id: '01-ingestion',
  name: 'Ingestion',
  version: 1,
  nodes: [
    {
      id: 'webhook', type: 'trigger.webhook', label: 'POST /soc/alert',
      note: 'The pipeline\u2019s entry point. The body received is untrusted data.',
      params: { path: 'soc/alert', method: 'POST' }, position: { x: 0, y: 0 },
    },
    {
      id: 'validate', type: 'transform', label: 'Schema validation',
      note: 'Never throws: it sets `validation_ok` and the list of what is missing.',
      params: { fn: 'validateAlertSchema' }, position: { x: 220, y: 0 },
    },
    {
      id: 'schema-ok', type: 'if', label: 'Schema valid?',
      params: { condition: { left: fromInput('validation_ok'), op: 'isTrue' } },
      position: { x: 440, y: 0 },
    },
    {
      id: 'respond-400', type: 'respond', label: 'Rejected — invalid schema',
      note: 'Says WHAT is missing, not \u201cinvalid\u201d: the sender has to be able to fix it.',
      params: { status: 400, body: { kind: 'const', value: null }, fn: 'rejectionBody' },
      position: { x: 660, y: 160 },
    },
    {
      id: 'dedup', type: 'postgres', label: 'Deduplication (INSERT ON CONFLICT)',
      note: 'ON CONFLICT, not WHERE NOT EXISTS: the second is not race-safe.',
      params: {
        /*
          RACE-SAFE, AND IT WAS NOT.

          This read `WHERE NOT EXISTS (SELECT 1 FROM existing)`, which looks
          atomic inside one statement and is not: under MVCC two concurrent
          transactions both see the row as absent, both insert, and one dies on
          `duplicate key value violates unique constraint`.

          Measured, not theorised: twelve simultaneous sends of one alert_id
          answered ten 200s, one 202 and one **500**. A 500 tells the sender to
          retry, which is precisely wrong — the alert was already accepted —
          and a source retrying a burst would keep producing them.

          `ON CONFLICT DO NOTHING` pushes the decision into the index, where it
          is atomic by construction. The outer SELECT then always returns
          EXACTLY ONE ROW, which is what keeps `interpretDedup`'s other
          guarantee intact: an empty answer still means "the store did not
          answer", never "this alert is new".
        */
        sql:
          'WITH inserted AS ('
          + 'INSERT INTO soc_ingested_alerts (alert_id, first_seen_at) VALUES ($1, now()) '
          + 'ON CONFLICT (alert_id) DO NOTHING RETURNING alert_id) '
          + 'SELECT NOT EXISTS (SELECT 1 FROM inserted) AS is_duplicate',
        params: [fromNode('validate', 'payload.alert_id')],
      },
      retry: { attempts: 2, backoffMs: 400 },
      position: { x: 660, y: 0 },
    },
    {
      id: 'respond-500', type: 'respond', label: 'Error — dedup store unavailable',
      note: '`retry_safe: true`: nothing was consumed, the sender may replay.',
      params: { status: 500, fn: 'dedupDownBody' }, position: { x: 880, y: 200 },
    },
    {
      id: 'read-dedup', type: 'transform', label: 'Read the dedup verdict',
      note: 'Refuses to conclude on an empty answer rather than assuming "new".',
      params: { fn: 'interpretDedup' }, position: { x: 880, y: 0 },
    },
    {
      id: 'is-duplicate', type: 'if', label: 'Already seen?',
      params: { condition: { left: fromInput('is_duplicate'), op: 'isTrue' } },
      position: { x: 1100, y: 0 },
    },
    {
      id: 'respond-200', type: 'respond', label: 'Duplicate ignored',
      params: { status: 200, fn: 'duplicateBody' }, position: { x: 1320, y: 120 },
    },
    {
      id: 'respond-202', type: 'respond', label: 'Accepted',
      params: { status: 202, fn: 'acceptedBody' }, position: { x: 1320, y: -80 },
    },
    // --- Tuning rules -------------------------------------------------------
    // Placed AFTER deduplication and BEFORE enrichment: a known-good alert
    // should cost neither three enrichment calls nor a model call, and it
    // still has to be recorded, so it cannot be dropped earlier than this.
    {
      id: 'rules-load', type: 'postgres', label: 'Active tuning rules',
      note: 'Expired ones are filtered here AND in the engine: never one without the other.',
      params: {
        sql:
          'SELECT id, name, enabled, priority, conditions, action, severity, owner, '
          + 'reason, expires_at, created_at, updated_at FROM soc_tuning_rule '
          + 'WHERE enabled AND (expires_at IS NULL OR expires_at > now()) '
          + 'ORDER BY priority ASC, id ASC',
        params: [],
      },
      retry: { attempts: 2, backoffMs: 300 },
      position: { x: 1540, y: -220 },
    },
    {
      id: 'tuning', type: 'transform', label: 'Apply the rules',
      note: 'First matching rule wins. A rule can only close, soften or escalate.',
      params: {
        fn: 'applyTuningRules',
        // JONCTION DÉCLARÉE : l'alerte vient de `validate`, les règles de
        // `rules-load`. Sans ce câblage le nœud ne verrait que la sortie du
        // premier amont arrivé — le défaut déjà corrigé sur `assemble` et
        // sur `finalize`.
        inputs: {
          alert: fromNode('validate', 'payload'),
          // `.rows`, not the node output: a `postgres` node answers
          // `{ rows: [...] }`. Reading one level too high handed the transform
          // an object where it expected an array, and an unreadable rule set
          // is indistinguishable from an empty one — every rule silently
          // stopped applying.
          //
          // On the ERROR branch the output is `{ error }` and this resolves to
          // `undefined`, which is also an empty rule set. That direction is
          // the safe one: no rules means noisier, never more permissive.
          rows: fromNode('rules-load', 'rows'),
        },
      },
      position: { x: 1540, y: -80 },
    },
    {
      id: 'tuned-out', type: 'if', label: 'Does a rule close the alert?',
      params: { condition: { left: fromInput('closed_by_rule'), op: 'isTrue' } },
      position: { x: 1760, y: -80 },
    },
    {
      id: 'to-audit-tuned', type: 'subflow', label: 'Closed by rule → 05-Audit-Log',
      note: 'CLOSED, NOT DROPPED: an alert nobody can find is indistinguishable from one never received.',
      // The FLAT payload, not the whole node output: 05 reads `alert_id` at
      // the top level, and anything else is filed as an unusable row — which
      // it records by writing nothing at all.
      params: { workflowId: '05-audit-log', input: fromInput('audit_payload') },
      position: { x: 1980, y: 40 },
    },
    {
      id: 'to-enrichment', type: 'subflow', label: 'Hand off to 02-Enrichment',
      note: 'The input is explicit: a sub-workflow started empty is refused.',
      params: { workflowId: '02-enrichment', input: fromInput('alert') },
      position: { x: 1980, y: -160 },
    },
  ],
  edges: [
    link('webhook', 'validate'),
    link('validate', 'schema-ok'),
    link('schema-ok', 'respond-400', 'false'),
    link('schema-ok', 'dedup', 'true'),
    // La branche d'erreur est CÂBLÉE : plus d'item fantôme sur la sortie
    // principale, donc plus de « accepted » sur une déduplication échouée.
    link('dedup', 'respond-500', 'error'),
    link('dedup', 'read-dedup'),
    link('read-dedup', 'is-duplicate'),
    link('is-duplicate', 'respond-200', 'true'),
    link('is-duplicate', 'respond-202', 'false'),
    link('respond-202', 'rules-load'),
    // La base de règles injoignable ne doit PAS perdre l'alerte : on continue
    // sans réglage plutôt que d'arrêter la chaîne. Un réglage absent rend le
    // pipeline plus bavard, jamais plus permissif.
    link('rules-load', 'tuning', 'error'),
    link('rules-load', 'tuning'),
    link('tuning', 'tuned-out'),
    link('tuned-out', 'to-audit-tuned', 'true'),
    link('tuned-out', 'to-enrichment', 'false'),
  ],
};

// =============================================================================
// 02 — ENRICHMENT
// =============================================================================

export const ENRICHMENT: WorkflowDef = {
  id: '02-enrichment',
  name: 'Enrichment',
  version: 1,
  nodes: [
    {
      id: 'in', type: 'trigger.subflow', label: 'Received from 01-Ingestion',
      params: {}, position: { x: 0, y: 0 },
    },
    {
      id: 'guard', type: 'transform', label: 'Input guard',
      note: 'Also decides what we are ALLOWED to query: no hash \u2192 no VirusTotal; private IP \u2192 no Shodan.',
      params: { fn: 'guardEnrichmentPayload' }, position: { x: 220, y: 0 },
    },
    {
      id: 'payload-ok', type: 'if', label: 'Payload usable?',
      params: { condition: { left: fromInput('payload_ok'), op: 'isTrue' } },
      position: { x: 440, y: 0 },
    },
    {
      id: 'reject', type: 'respond', label: 'Payload unusable',
      params: { status: 422, fn: 'enrichmentRejection' }, position: { x: 660, y: 200 },
    },
    // Les trois sources sont indépendantes : l'échec de l'une n'empêche
    // jamais les autres. Elles sortent toutes par `main`, même en erreur —
    // c'est le normaliseur qui traduit l'échec en `unavailable`.
    {
      id: 'shodan', type: 'http', label: 'Shodan',
      params: {
        url: constant('https://api.shodan.io/shodan/host/'),
        authHeader: { header: 'key', secret: 'shodan.apiKey' },
        timeoutMs: 8000,
      },
      position: { x: 660, y: -140 },
    },
    {
      id: 'abuseipdb', type: 'http', label: 'AbuseIPDB',
      params: {
        url: constant('https://api.abuseipdb.com/api/v2/check'),
        authHeader: { header: 'Key', secret: 'abuseipdb.apiKey' },
        timeoutMs: 8000,
      },
      position: { x: 660, y: 0 },
    },
    {
      id: 'virustotal', type: 'http', label: 'VirusTotal',
      params: {
        url: constant('https://www.virustotal.com/api/v3/files/'),
        authHeader: { header: 'x-apikey', secret: 'virustotal.apiKey' },
        timeoutMs: 8000,
      },
      position: { x: 660, y: 140 },
    },
    {
      id: 'assemble', type: 'transform', label: 'Assembly',
      note: 'Three distinct states, and they stay distinct: ok, skipped, unavailable.',
      params: {
        fn: 'assembleEnriched',
        // ENTRÉES NOMMÉES, et c'est indispensable : ce nœud est une JONCTION.
        // Sans ce câblage explicite il ne recevrait que la sortie du premier
        // amont arrivé, et assemblerait un tiers des données sans le dire.
        inputs: {
          guard: fromNode('guard', ''),
          shodan: fromNode('shodan', ''),
          abuseipdb: fromNode('abuseipdb', ''),
          virustotal: fromNode('virustotal', ''),
        },
      },
      position: { x: 900, y: 0 },
    },
    {
      id: 'to-decision', type: 'subflow', label: 'Hand off to 03-AI-Decision',
      params: { workflowId: '03-ai-decision' }, position: { x: 1120, y: 0 },
    },
  ],
  edges: [
    link('in', 'guard'),
    link('guard', 'payload-ok'),
    link('payload-ok', 'reject', 'false'),
    link('payload-ok', 'shodan', 'true'),
    link('payload-ok', 'abuseipdb', 'true'),
    link('payload-ok', 'virustotal', 'true'),
    link('shodan', 'assemble'),
    link('shodan', 'assemble', 'error'),
    link('abuseipdb', 'assemble'),
    link('abuseipdb', 'assemble', 'error'),
    link('virustotal', 'assemble'),
    link('virustotal', 'assemble', 'error'),
    link('assemble', 'to-decision'),
  ],
};

// =============================================================================
// 03 — AI DECISION
// =============================================================================

export const DECISION: WorkflowDef = {
  id: '03-ai-decision',
  name: 'AI Decision',
  version: 1,
  nodes: [
    {
      id: 'in', type: 'trigger.subflow', label: 'Received from 02-Enrichment',
      params: {}, position: { x: 0, y: 0 },
    },
    {
      id: 'guard', type: 'transform', label: 'Input guard',
      params: { fn: 'guardDecisionPayload' }, position: { x: 200, y: 0 },
    },
    {
      id: 'payload-ok', type: 'if', label: 'Payload usable?',
      params: { condition: { left: fromInput('payload_ok'), op: 'isTrue' } },
      position: { x: 400, y: 0 },
    },
    {
      id: 'prompt', type: 'transform', label: 'Build the prompt',
      note: 'Tells the model the payload is DATA, not an instruction.',
      params: { fn: 'buildDecisionPrompt' }, position: { x: 600, y: 0 },
    },
    {
      id: 'model', type: 'llm', label: 'Triage decision',
      note: 'Structured output required. An incomplete answer is refused, never completed for it.',
      params: {
        model: fromVar('llm.model'),
        prompt: fromInput('prompt_text'),
        requiredKeys: ['verdict', 'confidence', 'reasoning', 'recommended_action', 'data_lineage'],
        timeoutMs: 60_000,
      },
      position: { x: 800, y: 0 },
    },
    {
      id: 'validate', type: 'transform', label: 'Validation + guardrails G6–G11',
      params: { fn: 'validateDecision' }, position: { x: 1000, y: 0 },
    },
    {
      id: 'valid', type: 'if', label: 'Decision compliant?',
      params: { condition: { left: fromInput('decision_valid'), op: 'isTrue' } },
      position: { x: 1200, y: 0 },
    },
    {
      id: 'correction', type: 'transform', label: 'Correction request',
      note: 'Everything is re-sent: nothing depends on a conversation history.',
      // Même défaut de câblage que sur `finalize`, et même correction.
      // `buildCorrectionPrompt` attend le verdict de validation sous
      // « previous » et le bloc d'alerte sous « alert_block » ; il recevait la
      // sortie brute de `validate`, qui ne porte ni l'un ni l'autre sous ces
      // noms. La seconde tentative mourait donc AVANT d'être formulée, et le
      // repli « schéma non conforme » n'était jamais atteint non plus.
      //
      // Le bloc d'alerte se relit chez `prompt` : le réinjecter INCHANGÉ est
      // justement ce que la note ci-dessus promet.
      params: {
        fn: 'buildCorrectionPrompt',
        inputs: {
          previous: fromInput(''),
          alert_block: fromNode('prompt', 'alert_block'),
        },
      },
      position: { x: 1200, y: 180 },
    },
    {
      id: 'model-retry', type: 'llm', label: 'Second attempt',
      params: {
        model: fromVar('llm.model'),
        prompt: fromInput('prompt_text'),
        requiredKeys: ['verdict', 'confidence', 'reasoning', 'recommended_action', 'data_lineage'],
        timeoutMs: 60_000,
      },
      position: { x: 1400, y: 180 },
    },
    {
      id: 'validate-retry', type: 'transform', label: 'Re-validation',
      params: { fn: 'validateDecision' }, position: { x: 1600, y: 180 },
    },
    {
      id: 'valid-retry', type: 'if', label: 'Compliant this time?',
      params: { condition: { left: fromInput('decision_valid'), op: 'isTrue' } },
      position: { x: 1800, y: 180 },
    },
    {
      id: 'fallback-schema', type: 'transform', label: 'Fallback — schema not compliant',
      note: 'An alert is NEVER lost: needs_human, confidence 0, escalate.',
      params: { fn: 'fallbackSchemaInvalid' }, position: { x: 1800, y: 360 },
    },
    {
      id: 'fallback-api', type: 'transform', label: 'Fallback — model unreachable',
      params: { fn: 'fallbackApiUnavailable' }, position: { x: 800, y: 360 },
    },
    {
      id: 'finalize', type: 'transform', label: 'Last barrier + shadow_mode',
      note: 'Corrects without asking. It can only make the decision more cautious.',
      // JONCTION DÉCLARÉE, et pas « la sortie de la branche arrivée ».
      //
      // `finalize` a TROIS amonts — `valid`, `fallback-schema`, `fallback-api`
      // — et AUCUN des trois ne reporte l'alerte : `validateDecision` rend
      // `{decision_valid, violations, decision, attempt, raw_output}` et
      // `fallbackDecision` rend `{fallback, decision_source, decision, …}`.
      // L'alerte se perdait donc sur les trois chemins, et la dernière
      // barrière — celle qui plafonne la confiance sur un enrichissement
      // dégradé — tombait sur `enrichment_meta` de `undefined`. 03 ne pouvait
      // aboutir sur AUCUN chemin : ni 04-Action-Routing ni 05-Audit-Log
      // n'étaient jamais atteints.
      //
      // L'alerte se relit chez `guard`, qui s'exécute sur tous les chemins ;
      // le reste vient de la branche qui vient d'arriver.
      params: {
        fn: 'finalizeDecision',
        inputs: {
          alert: fromNode('guard', 'alert'),
          decision: fromInput('decision'),
          decision_source: fromInput('decision_source'),
          fallback: fromInput('fallback'),
          model: fromInput('model'),
          attempt: fromInput('attempt'),
          usage: fromInput('usage'),
          violations: fromInput('violations'),
        },
      },
      position: { x: 2050, y: 0 },
    },
    {
      id: 'to-routing', type: 'subflow', label: 'Hand off to 04-Action-Routing',
      params: { workflowId: '04-action-routing' }, position: { x: 2250, y: 0 },
    },
    {
      id: 'reject', type: 'respond', label: 'Payload unusable',
      params: { status: 422, fn: 'decisionRejection' }, position: { x: 600, y: 200 },
    },
  ],
  edges: [
    link('in', 'guard'),
    link('guard', 'payload-ok'),
    link('payload-ok', 'reject', 'false'),
    link('payload-ok', 'prompt', 'true'),
    link('prompt', 'model'),
    // Modèle injoignable : repli, jamais une alerte perdue.
    link('model', 'fallback-api', 'error'),
    link('model', 'validate'),
    link('validate', 'valid'),
    link('valid', 'finalize', 'true'),
    link('valid', 'correction', 'false'),
    link('correction', 'model-retry'),
    link('model-retry', 'fallback-api', 'error'),
    link('model-retry', 'validate-retry'),
    link('validate-retry', 'valid-retry'),
    link('valid-retry', 'finalize', 'true'),
    // Deux tentatives suffisent : une troisième coûte un appel de plus pour un
    // modèle qui vient d'échouer deux fois sur des règles explicites.
    link('valid-retry', 'fallback-schema', 'false'),
    link('fallback-schema', 'finalize'),
    link('fallback-api', 'finalize'),
    link('finalize', 'to-routing'),
  ],
};

export const PIPELINE_WORKFLOWS = [INGESTION, ENRICHMENT, DECISION];
