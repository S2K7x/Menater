/**
 * Serveur MCP VulnPipe — expose l'index de code aux nodes de détection.
 *
 * ============================================================================
 * API SDK RÉELLEMENT OBSERVÉE (probe : `node scripts/probe-mcp.mjs`)
 *   @modelcontextprotocol/sdk : 1.30.0
 *   zod                       : 4.4.3
 *
 *   - `server.tool(...)` est DÉPRÉCIÉ dans cette version → on utilise
 *     `registerTool(name, { title, description, inputSchema }, cb)`.
 *   - `inputSchema` attend un **ZodRawShape** (objet de champs zod), PAS un
 *     `z.object({...})` déjà construit.
 *   - `client.callTool()` renvoie `{ content, structuredContent }`.
 *     `isError` vaut `undefined` en cas de succès — tester `=== true`,
 *     surtout pas la véracité d'un booléen supposé présent.
 *   - Une erreur de validation d'argument ne throw PAS côté client : elle
 *     revient en `{ isError: true, content: [{ text: "MCP error -32602: …" }] }`
 *     et le handler n'est jamais appelé.
 * ============================================================================
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { buildRepoIndex, type RepoIndex } from './repo-index.ts';
import {
  ContextResolutionError,
  DEFAULT_BYTE_BUDGET,
  DEFAULT_DEPTH,
  MAX_DEPTH,
  resolveContext,
} from './resolver.ts';

export const SERVER_NAME = 'vulnpipe-indexer';
export const SERVER_VERSION = '0.2.0';

/** Réponse d'erreur applicative, avec le résumé humain exigé par CLAUDE.md §4. */
function errorResult(message: string, plainLanguageSummary: string) {
  const payload = { error: message, plain_language_summary: plainLanguageSummary };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

function okResult(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

/**
 * Construit le serveur MCP autour d'un index déjà chargé.
 * L'index est injecté pour que les tests puissent le fabriquer en mémoire.
 */
export function createServer(index: RepoIndex): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'get_context',
    {
      title: 'Contexte de sécurité d’une route',
      description:
        "Renvoie le code réellement exécuté par une route HTTP : le handler, le corps des guards d'autorisation, et le corps des méthodes de service appelées, résolus à travers les fichiers. C'est l'entrée des nodes de détection.",
      inputSchema: {
        route: z.string().describe('Chemin de la route, ex. "/orders/:id"'),
        http_method: z
          .string()
          .optional()
          .describe(
            'Verbe HTTP (GET, POST...). Obligatoire si plusieurs verbes partagent la même route.'
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .max(MAX_DEPTH)
          .optional()
          .describe(`Profondeur de résolution des appels (défaut ${DEFAULT_DEPTH}, max ${MAX_DEPTH}).`),
        byte_budget: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Budget de code source renvoyé, en octets (défaut ${DEFAULT_BYTE_BUDGET}). Borne le coût d'analyse en aval.`
          ),
      },
    },
    async ({ route, http_method, depth, byte_budget }) => {
      try {
        return okResult(
          resolveContext(index, {
            route,
            httpMethod: http_method,
            depth,
            byteBudget: byte_budget,
          })
        );
      } catch (error) {
        if (error instanceof ContextResolutionError) {
          return errorResult(error.message, error.plainLanguageSummary);
        }
        return errorResult(
          `Erreur interne : ${(error as Error).message}`,
          "L'analyse de cette route a échoué pour une raison technique. Le code n'a pas été examiné : ne considère pas cette route comme sûre."
        );
      }
    }
  );

  /**
   * AJOUT (hors spec) : sans ce tool, un node de détection n'a aucun moyen de
   * savoir quelles routes existent — il faudrait les lui coder en dur. C'est
   * l'amorce du parcours en Phase 3.
   */
  server.registerTool(
    'list_routes',
    {
      title: 'Lister les routes indexées',
      description:
        "Énumère toutes les routes HTTP trouvées dans le projet, avec leur contrôleur et la présence ou non d'un contrôle d'accès. Sert aux nodes de détection à savoir quoi analyser.",
      inputSchema: {
        unguarded_only: z
          .boolean()
          .optional()
          .describe("Ne renvoyer que les routes sans aucun guard d'autorisation."),
      },
    },
    async ({ unguarded_only }) => {
      const routes = index.endpoints
        .filter((e) => !unguarded_only || e.endpoint.framework_metadata.is_unguarded)
        .map((e) => ({
          route: e.endpoint.route,
          http_method: e.endpoint.http_method.toUpperCase(),
          controller: e.controller.controller,
          handler: e.endpoint.handler,
          file: e.endpoint.source.file,
          guards: e.endpoint.framework_metadata.guards,
          is_unguarded: e.endpoint.framework_metadata.is_unguarded,
        }));

      const unguardedCount = routes.filter((r) => r.is_unguarded).length;
      return okResult({
        total: routes.length,
        routes,
        index_warnings: index.warnings,
        plain_language_summary:
          routes.length === 0
            ? 'No HTTP route was found in the indexed code.'
            : `${routes.length} HTTP route(s) found in the project, ${unguardedCount} of them with no declared access control. Those are the ones that deserve attention first.`,
      });
    }
  );

  return server;
}

/** Construit l'index depuis un dossier, puis le serveur. */
export function createServerFromDirectory(root: string): { server: McpServer; index: RepoIndex } {
  const index = buildRepoIndex(root);
  return { server: createServer(index), index };
}

/** Entrée CLI : `node --experimental-strip-types src/mcp-server/server.ts <dossier>` */
export async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) {
    console.error('usage: server.ts <dossier-du-repo-a-indexer>');
    process.exit(1);
  }
  const { server, index } = createServerFromDirectory(root);
  // stdout est réservé au protocole MCP : tout log applicatif va sur stderr.
  console.error(
    `[${SERVER_NAME}] ${index.files.length} fichier(s), ${index.classes.size} classe(s), ${index.endpoints.length} route(s) indexée(s).`
  );
  for (const warning of index.warnings) console.error(`[warn] ${warning}`);
  await server.connect(new StdioServerTransport());
}

// Exécution directe uniquement (pas lors d'un import depuis les tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
