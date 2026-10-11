/**
 * Probe API MCP — Phase 2, étape 1 (même discipline qu'en Phase 1 : on ne
 * suppose rien de la forme des retours du SDK, on l'observe).
 *
 * Lancer : node scripts/probe-mcp.mjs
 */
import { readFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

// Read off disk, NOT through the package specifier. The SDK's exports map has
// no `./package.json` entry and a `./*` wildcard pointing at `dist/esm/*`, so
// `import('@modelcontextprotocol/sdk/package.json')` resolves to the nested
// `{"type":"module"}` marker — `.default.version` is `undefined`, with no error.
// Measured on 1.30.0 and 1.32.1 alike, so this line printed `undefined` for
// every version this probe has ever been run against, and the banner in
// `src/mcp-server/server.ts` credited it for a number it never produced.
const sdkVersion = JSON.parse(
  readFileSync(new URL('../node_modules/@modelcontextprotocol/sdk/package.json', import.meta.url), 'utf8')
).version;
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
// Read `isError`, not just whether the call threw. Printing "validation does
// not block" because nothing threw says the opposite of what happens: the
// refusal travels in the RESULT, and the handler is never reached.
let calls = 0;
server.registerTool('counted', { description: 'x', inputSchema: { route: z.string() } }, async (a) => {
  calls++;
  return { content: [{ type: 'text', text: JSON.stringify(a) }] };
});
try {
  const bad = await client.callTool({ name: 'counted', arguments: {} });
  console.log('throw côté client  : non');
  console.log('isError            :', bad.isError, '| handler appelé :', calls, 'fois');
  console.log('text               :', String(bad.content?.[0]?.text).slice(0, 100));
} catch (e) {
  console.log('throw côté client  :', e.constructor.name, '|', String(e.message).slice(0, 120));
}

await client.close();
await server.close();
