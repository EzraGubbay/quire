import { type NextFetchEvent, type NextRequest, NextResponse } from 'next/server';
import { AUTH_MODE, auth, githubConfigured } from '@/auth';
import { type CallerEnv, classify, RESEARCH_MCP_PATH } from '@/core/identity/caller';

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

/**
 * Built per request: the keys are read at call time (tests set them per case; prod reads them at runtime).
 * AUTH_MODE and githubConfigured come from @/auth exactly as before.
 */
function callerEnv(): CallerEnv {
  return {
    authMode: AUTH_MODE,
    githubConfigured,
    masterKey: process.env.QUIRE_API_KEY,
    researchKey: process.env.QUIRE_RESEARCH_API_KEY,
  };
}

export function proxy(req: NextRequest, event: NextFetchEvent) {
  const { kind } = classify(
    { method: req.method, pathname: req.nextUrl.pathname, headers: req.headers },
    callerEnv(),
  );
  switch (kind) {
    case 'public':
    case 'local':
    case 'research-key':
    case 'master-key':
      return NextResponse.next();
    case 'unconfigured':
      return new NextResponse('Login is not configured: set AUTH_GITHUB_ID and AUTH_GITHUB_SECRET.', {
        status: 503,
      });
    case 'needs-session':
      return withSession(req as never, event as never);
    default: {
      // Fail closed: a kind added to the classifier without a mapping here must never fall through to the
      // framework's default (continue) behaviour.
      const unmapped: never = kind;
      void unmapped;
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }
}

export const config = { matcher: ['/((?!_next/static/|_next/image$|favicon\\.ico$).*)'] };
