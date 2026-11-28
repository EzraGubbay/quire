import { type NextFetchEvent, type NextRequest, NextResponse } from 'next/server';
import { AUTH_MODE, auth, githubConfigured } from '@/auth';
import { isPublic } from '@/core/identity/caller';
import { isApiKeyAuthorization, isResearchApiKeyAuthorization, RESEARCH_MCP_PATH } from '@/lib/api-key';

// Public-path rules live in core/identity/caller.ts; re-exported for existing importers.
export { isPublic } from '@/core/identity/caller';

const withSession = auth((req) => {
  if (req.auth?.user) return NextResponse.next();
  // API and MCP clients get a clean 401; only browser page routes redirect to sign-in.
  const p = req.nextUrl.pathname;
  if (p.startsWith('/api/') || p === '/mcp' || p.startsWith('/mcp/') || p === RESEARCH_MCP_PATH) {
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
  // The research key opens exactly /research/mcp (exact match, never a prefix) and never a Server Action.
  if (
    pathname === RESEARCH_MCP_PATH &&
    !req.headers.has('next-action') &&
    isResearchApiKeyAuthorization(req.headers.get('authorization'))
  ) {
    return NextResponse.next();
  }
  if (isApiKeyAuthorization(req.headers.get('authorization'))) return NextResponse.next();
  if (!githubConfigured) {
    return new NextResponse('Login is not configured: set AUTH_GITHUB_ID and AUTH_GITHUB_SECRET.', {
      status: 503,
    });
  }
  return withSession(req as never, event as never);
}

export const config = { matcher: ['/((?!_next/static/|_next/image$|favicon\\.ico$).*)'] };
