/** The only path the research key authenticates. Exact match: never a prefix. */
export const RESEARCH_MCP_PATH = '/research/mcp';

/** The parts of a request the classifier reads. A NextRequest fits as { method, pathname: nextUrl.pathname, headers }. */
export type CallerRequest = Readonly<{
  method: string;
  pathname: string;
  headers: Pick<Headers, 'has' | 'get'>;
}>;

/** True when the header is exactly `Bearer <key>`. An unset or empty key never matches. */
export function bearerMatches(header: string | null, key: string | undefined): boolean {
  if (!key) return false;
  return header === `Bearer ${key}`;
}

/**
 * The research exact-path rule: the research key may open exactly RESEARCH_MCP_PATH (never a prefix, never a
 * trailing slash) and never a Server Action (next-action header). Method-agnostic, as the proxy has always been.
 */
export function isResearchMcpRequest(req: Pick<CallerRequest, 'pathname' | 'headers'>): boolean {
  return req.pathname === RESEARCH_MCP_PATH && !req.headers.has('next-action');
}
