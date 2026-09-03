import { type NextFetchEvent, type NextRequest, NextResponse } from 'next/server';
import { AUTH_MODE, auth, githubConfigured } from '@/auth';

// Reachable without a session: health (probed over localhost by the deploy job), the auth routes
// themselves, the PWA manifest and icons.
const PUBLIC_PREFIXES = ['/api/health', '/api/auth/', '/manifest.webmanifest', '/icons/'];

function bearerOk(req: NextRequest): boolean {
  const key = process.env.QUIRE_API_KEY;
  if (!key) return false;
  const header = req.headers.get('authorization') ?? '';
  return header === `Bearer ${key}`;
}

const withSession = auth((req) => {
  if (req.auth?.user) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith('/api/')) return new NextResponse('Unauthorized', { status: 401 });
  const signIn = new URL('/api/auth/signin', req.nextUrl.origin);
  signIn.searchParams.set('callbackUrl', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(signIn);
});

export function proxy(req: NextRequest, event: NextFetchEvent) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (AUTH_MODE === 'none') return NextResponse.next();
  if (bearerOk(req)) return NextResponse.next();
  if (!githubConfigured) {
    return new NextResponse('Login is not configured: set AUTH_GITHUB_ID and AUTH_GITHUB_SECRET.', {
      status: 503,
    });
  }
  return withSession(req as never, event as never);
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
