// The Quire MCP endpoint (Streamable HTTP, stateless). Reachable at https://quire.ezragubbay.com/mcp,
// behind proxy.ts — a machine client authenticates with `Authorization: Bearer $QUIRE_API_KEY`
// (AUTH_MODE=github) or nothing (AUTH_MODE=none). Tools/resources live in registerQuireMcp so auth can be
// swapped later without touching them.
import { createMcpHandler } from 'mcp-handler';
import { registerQuireMcp } from '@/lib/mcp/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    registerQuireMcp(server);
  },
  { capabilities: { tools: {}, resources: {} } },
  // basePath '/' means the Streamable-HTTP endpoint is '/mcp' (this route). No redisUrl → stateless.
  { basePath: '/', verboseLogs: process.env.NODE_ENV !== 'production', maxDuration: 60 },
);

export { handler as GET, handler as POST, handler as DELETE };
