import { type NextFetchEvent, type NextRequest, NextResponse } from 'next/server';
import { AUTH_MODE, auth, githubConfigured } from '@/auth';
import { isApiKeyAuthorization } from '@/lib/api-key';

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

const withSession = auth((req) => {
  if (req.auth?.user) return NextResponse.next();
  // API and MCP clients get a clean 401; only browser page routes redirect to sign-in.
  const p = req.nextUrl.pathname;
  if (p.startsWith('/api/') || p === '/mcp' || p.startsWith('/mcp/')) {
    return new NextResponse('Unauthorized', { status: 401 });
  }
  const signIn = new URL('/api/auth/signin', req.nextUrl.origin);
  signIn.searchParams.set('callbackUrl', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(signIn);
});

export function proxy(req: NextRequest, event: NextFetchEvent) {
  const { pathname } = req.nextUrl;
  if (isPublic(req.method, pathname, req.headers)) return NextResponse.next();
  if (AUTH_MODE === 'none') return NextResponse.next();
  if (isApiKeyAuthorization(req.headers.get('authorization'))) return NextResponse.next();
  if (!githubConfigured) {
    return new NextResponse('Login is not configured: set AUTH_GITHUB_ID and AUTH_GITHUB_SECRET.', {
      status: 503,
    });
  }
  return withSession(req as never, event as never);
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
