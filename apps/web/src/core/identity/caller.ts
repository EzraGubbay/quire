/** The only path the research key authenticates. Exact match: never a prefix. */
export const RESEARCH_MCP_PATH = '/research/mcp';

/** The parts of a request the classifier reads. A NextRequest fits as { method, pathname: nextUrl.pathname, headers }. */
export type CallerRequest = Readonly<{
  method: string;
  pathname: string;
  headers: Pick<Headers, 'has' | 'get'>;
}>;

/** Who is calling, as far as the proxy can tell from the request alone (no session lookup). */
export type CallerKind =
  | 'public'
  | 'local'
  | 'master-key'
  | 'research-key'
  | 'needs-session'
  | 'unconfigured';
export type Caller = Readonly<{ kind: CallerKind }>;

/** Injected by the transport at call time; core never reads the environment. */
export type CallerEnv = Readonly<{
  /** Compared with === 'none' only, exactly like the proxy always has: 'GitHub' and '' are not 'none'. */
  authMode: string;
  masterKey: string | undefined;
  researchKey: string | undefined;
  githubConfigured: boolean;
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

// Public means "reachable without a session". It is deliberately narrow: Server Actions are directly
// POSTable to any URL, so a loose prefix (e.g. `/icons/` matching `/icons/x/documents/y`, which falls
// through to app/[side]/[slug]) would let anyone run them unauthenticated.

// Any method: these are route handlers (never action hosts) that do their own auth.
// Mobile API v1 handlers do per-device bearer auth (src/lib/mobile/device-auth.ts), so a missing/invalid
// token gets the JSON 401 envelope rather than the session gate. The trailing slash matters: it excludes
// /api/mobile/pairing-codes (the mint route), which stays session-gated.
// Single-use MCP upload links: PUT to exactly one 43-char token segment, authorized solely by that token
// (see lib/mcp/upload-links.ts). Deliberately not a prefix: deeper paths must stay session-gated.
const UPLOAD_LINK_PUT = /^\/api\/upload-links\/[A-Za-z0-9_-]{43}$/;

const PUBLIC_ANY_METHOD_PREFIXES = ['/api/auth/', '/api/mobile/v1/'];

// GET/HEAD, exact paths only: health (probed over localhost by the deploy job), the PWA manifest, service
// worker, offline page and the pdf.js worker.
const PUBLIC_EXACT = new Set([
  '/api/health',
  '/manifest.webmanifest',
  '/sw.js',
  '/offline',
  '/pdf.worker.min.mjs',
]);

// GET/HEAD static assets, anchored and extension-restricted. pdf.js fetches its fonts and CMaps from
// inside its worker; public like the worker itself (fonts and CMaps are not private).
const PUBLIC_ASSETS = [
  /^\/icons\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.png$/,
  /^\/pdfjs\/(?:cmaps|standard_fonts)\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:bcmap|pfb|ttf)$/,
  /^\/mathjax\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|woff2?|ttf|json|css)$/,
];

export function isPublic(method: string, pathname: string, headers: Pick<Headers, 'has'>): boolean {
  // A public path never runs a Server Action without auth.
  if (headers.has('next-action')) return false;
  if (PUBLIC_ANY_METHOD_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if (method === 'PUT' && UPLOAD_LINK_PUT.test(pathname)) return true;
  // MPA form posts carry the action id in the body, not a header, so restrict by method too.
  if (method !== 'GET' && method !== 'HEAD') return false;
  return PUBLIC_EXACT.has(pathname) || PUBLIC_ASSETS.some((re) => re.test(pathname));
}

/**
 * Classify a request. The order is the proxy's decision order and must not change: public, local (auth off),
 * research key, master key, unconfigured login, otherwise a session is needed.
 */
export function classify(req: CallerRequest, env: CallerEnv): Caller {
  if (isPublic(req.method, req.pathname, req.headers)) return { kind: 'public' };
  if (env.authMode === 'none') return { kind: 'local' };
  const authorization = req.headers.get('authorization');
  if (isResearchMcpRequest(req) && bearerMatches(authorization, env.researchKey)) {
    return { kind: 'research-key' };
  }
  if (bearerMatches(authorization, env.masterKey)) return { kind: 'master-key' };
  if (!env.githubConfigured) return { kind: 'unconfigured' };
  return { kind: 'needs-session' };
}

export type Capabilities = Readonly<{
  /** What the proxy does: let it through, hand it to the session gate, or answer 503. */
  proxy: 'pass' | 'session-gate' | 'unavailable';
  /** Paths the caller may reach: only isPublic paths, every path, exactly RESEARCH_MCP_PATH, whatever a session allows, or nothing. */
  reach: 'public' | 'any' | 'research-mcp' | 'session' | 'none';
  /** May it run a Server Action (a next-action request)? 'session' = only with an allowed session (requireSession). */
  serverActions: 'yes' | 'no' | 'session';
}>;

const CAPABILITIES: Readonly<Record<CallerKind, Capabilities>> = {
  public: { proxy: 'pass', reach: 'public', serverActions: 'no' },
  local: { proxy: 'pass', reach: 'any', serverActions: 'yes' },
  'master-key': { proxy: 'pass', reach: 'any', serverActions: 'yes' },
  'research-key': { proxy: 'pass', reach: 'research-mcp', serverActions: 'no' },
  'needs-session': { proxy: 'session-gate', reach: 'session', serverActions: 'session' },
  unconfigured: { proxy: 'unavailable', reach: 'none', serverActions: 'no' },
};

export function capabilities(kind: CallerKind): Capabilities {
  return CAPABILITIES[kind];
}
