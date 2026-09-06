/**
 * Client MCP générique, partagé par tous les nodes de détection.
 *
 * PHASE_3 : « Ne code pas de logique spécifique à IDOR dans le client MCP ou
 * le wrapper Ollama : garde-les génériques dans src/nodes/shared/. »
 * Ce fichier ne connaît donc ni IDOR, ni XSS, ni SQLi.
 *
 * Deux transports :
 *  - `connectInProcess` : relie le node au serveur MCP dans le même process
 *    (InMemoryTransport). Utilisé par les tests et le mono-repo local.
 *  - `connectStdio`     : lance le serveur en sous-processus, pour le jour où
 *    l'Indexeur tournera séparément (Phase 6, orchestration).
 */

import { DEFAULT_LOCALE, type Locale } from '../../i18n/locale.ts';
import { messages } from '../../i18n/messages.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ContextBundle } from '../../mcp-server/resolver.ts';

export interface RouteRef {
  route: string;
  httpMethod?: string;
}

/** Erreur d'accès au contexte — distincte d'un verdict de sécurité. */
export class McpAccessError extends Error {
  readonly plainLanguageSummary: string;

  constructor(message: string, plainLanguageSummary: string) {
    super(message);
    this.name = 'McpAccessError';
    this.plainLanguageSummary = plainLanguageSummary;
  }
}

export interface ContextProvider {
  getContext(ref: RouteRef, depth: number): Promise<ContextBundle>;
  listRoutes(options?: { unguardedOnly?: boolean }): Promise<ListedRoute[]>;
  close(): Promise<void>;
}

export interface ListedRoute {
  route: string;
  http_method: string;
  controller: string;
  handler: string;
  file: string;
  guards: string[];
  is_unguarded: boolean;
}

/** Enveloppe un client MCP connecté en fournisseur de contexte typé. */
export class McpContextProvider implements ContextProvider {
  // Champs déclarés puis assignés : les "parameter properties" TS ne passent
  // pas le strip-only mode de Node (limitation notée en Phase 2, ROADMAP.md).
  private readonly client: Client;
  private readonly onClose?: () => Promise<void>;
  private readonly locale: Locale;

  constructor(client: Client, onClose?: () => Promise<void>, locale: Locale = DEFAULT_LOCALE) {
    this.client = client;
    this.onClose = onClose;
    this.locale = locale;
  }

  async getContext(ref: RouteRef, depth: number): Promise<ContextBundle> {
    const result = await this.client.callTool({
      name: 'get_context',
      arguments: {
        route: ref.route,
        ...(ref.httpMethod ? { http_method: ref.httpMethod } : {}),
        depth,
      },
    });

    // Rappel du probe Phase 2 : `isError` vaut `undefined` en succès —
    // toujours comparer à `true`, jamais tester la véracité.
    if (result.isError === true) {
      const payload = result.structuredContent as
        | { error?: string; plain_language_summary?: string }
        | undefined;
      throw new McpAccessError(
        payload?.error ?? 'The context server refused the get_context request.',
        payload?.plain_language_summary ?? messages(this.locale).context.routeUnknown
      );
    }

    return result.structuredContent as unknown as ContextBundle;
  }

  async listRoutes(options: { unguardedOnly?: boolean } = {}): Promise<ListedRoute[]> {
    const result = await this.client.callTool({
      name: 'list_routes',
      arguments: options.unguardedOnly ? { unguarded_only: true } : {},
    });
    if (result.isError === true) {
      throw new McpAccessError(
        'The context server refused the list_routes request.',
        messages(this.locale).context.listFailed
      );
    }
    return (result.structuredContent as unknown as { routes: ListedRoute[] }).routes;
  }

  async close(): Promise<void> {
    await this.client.close();
    if (this.onClose) await this.onClose();
  }
}

/** Relie un node à un serveur MCP vivant dans le même process. */
export async function connectInProcess(
  server: McpServer,
  locale: Locale = DEFAULT_LOCALE
): Promise<McpContextProvider> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'vulnpipe-detection-node', version: '0.3.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return new McpContextProvider(client, () => server.close(), locale);
}

/** Relie un node à un serveur MCP lancé en sous-processus (stdio). */
export async function connectStdio(command: string, args: string[]): Promise<McpContextProvider> {
  const transport = new StdioClientTransport({ command, args });
  const client = new Client({ name: 'vulnpipe-detection-node', version: '0.3.0' });
  await client.connect(transport);
  return new McpContextProvider(client);
}
