import { type NextRequest, NextResponse } from 'next/server';
import { verifyAccess } from '@/lib/auth';

// Health is reachable without Access so the deploy job on the Pi can probe it over localhost.
const PUBLIC = ['/api/health', '/manifest.webmanifest', '/icons/'];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  const identity = await verifyAccess(req.headers);
  if (!identity) return new NextResponse('Unauthorized', { status: 401 });
  const res = NextResponse.next();
  if (identity.email) res.headers.set('x-quire-user', identity.email);
  return res;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
