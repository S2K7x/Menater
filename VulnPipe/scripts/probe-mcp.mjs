/**
 * Probe API MCP — Phase 2, étape 1 (même discipline qu'en Phase 1 : on ne
 * suppose rien de la forme des retours du SDK, on l'observe).
 *
 * Lancer : node scripts/probe-mcp.mjs
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

const sdkVersion = (await import('@modelcontextprotocol/sdk/package.json', { with: { type: 'json' } }))
  .default.version;
console.log('=== VERSIONS ===');
console.log('node                     :', process.version);
console.log('@modelcontextprotocol/sdk:', sdkVersion);
console.log('zod                      :', (await import('zod/package.json', { with: { type: 'json' } })).default.version);

const server = new McpServer({ name: 'probe', version: '0.0.0' });

server.registerTool(
  'echo_ctx',
  {
    title: 'Echo',
    description: 'probe tool',
    inputSchema: { route: z.string(), depth: z.number().int().optional() },
  },
  async ({ route, depth }) => ({
    content: [{ type: 'text', text: JSON.stringify({ route, depth: depth ?? 2 }) }],
    structuredContent: { route, depth: depth ?? 2 },
  })
);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'probe-client', version: '0.0.0' });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

console.log('\n=== listTools() ===');
const tools = await client.listTools();
console.log('clés du retour     :', Object.keys(tools));
console.log('clés d un tool     :', Object.keys(tools.tools[0]));
console.log('inputSchema réel   :', JSON.stringify(tools.tools[0].inputSchema));

console.log('\n=== callTool() ===');
const res = await client.callTool({ name: 'echo_ctx', arguments: { route: '/orders/:id', depth: 2 } });
console.log('clés du retour     :', Object.keys(res));
console.log('content[0]         :', JSON.stringify(res.content[0]));
console.log('structuredContent  :', JSON.stringify(res.structuredContent));
console.log('isError            :', res.isError);

console.log('\n=== erreur applicative (isError: true) ===');
server.registerTool('boom', { description: 'x', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'échec volontaire' }],
  isError: true,
}));
const err = await client.callTool({ name: 'boom', arguments: {} });
console.log('isError            :', err.isError, '| text:', err.content[0].text);

console.log('\n=== validation zod côté serveur (argument manquant) ===');
try {
  await client.callTool({ name: 'echo_ctx', arguments: {} });
  console.log('!! pas d erreur — la validation ne bloque pas');
} catch (e) {
  console.log('throw côté client  :', e.constructor.name, '|', String(e.message).slice(0, 120));
}

await client.close();
await server.close();
