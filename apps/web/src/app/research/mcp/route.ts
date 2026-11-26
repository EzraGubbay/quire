// The Quire Research MCP endpoint (Streamable HTTP, stateless) at https://quire.ezragubbay.com/research/mcp.
// Its own connector: own URL, own credential (QUIRE_RESEARCH_API_KEY), own write flag. proxy.ts lets that key
// through on exactly this path; this route re-checks it and REJECTS the master QUIRE_API_KEY (one credential per
// connector). AUTH_MODE=none (local/e2e) stays open. An unset key means closed (401).
import { createMcpHandler } from 'mcp-handler';
import { isResearchApiKeyAuthorization } from '@/lib/api-key';
import { registerQuireResearchMcp } from '@/lib/mcp-research/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const mcp = createMcpHandler(
  (server) => {
    registerQuireResearchMcp(server);
  },
  { capabilities: { tools: {}, resources: {} } },
  // basePath '/research' means the Streamable-HTTP endpoint is '/research/mcp' (this route). Stateless.
  { basePath: '/research', verboseLogs: process.env.NODE_ENV !== 'production', maxDuration: 60 },
);

const guarded = (req: Request): Response | Promise<Response> => {
  // Same default as @/auth and requireSession.
  if ((process.env.AUTH_MODE ?? 'none') !== 'none') {
    if (!isResearchApiKeyAuthorization(req.headers.get('authorization'))) {
      return new Response('Unauthorized', { status: 401 });
    }
  }
  return mcp(req);
};

export { guarded as GET, guarded as POST, guarded as DELETE };
