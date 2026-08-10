/**
 * middleware.js — gate every route and API path except the login pair.
 *
 * This runs in the Edge runtime, so it uses jose to actually verify the JWT
 * signature. A middleware that only checks "is a cookie present" is trivially
 * bypassed by setting any cookie value.
 */

import { NextResponse } from 'next/server';
import { COOKIE_NAME, verifySessionToken } from './lib/auth.js';

const PUBLIC_PATHS = new Set(['/login', '/api/login']);

export async function middleware(request) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const token = request.cookies.get(COOKIE_NAME)?.value;
  const session = await verifySessionToken(token);

  if (session) {
    return NextResponse.next();
  }

  // APIs get a clean 401 — a 307 to an HTML login page would make fetch()
  // callers parse markup and report a nonsense error.
  if (pathname.startsWith('/api/')) {
    return new NextResponse(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const loginUrl = new URL('/login', request.url);
  if (pathname !== '/') loginUrl.searchParams.set('next', pathname);
  const redirect = NextResponse.redirect(loginUrl);
  // Clear a stale/expired cookie so the browser stops resending it.
  if (token) redirect.cookies.delete(COOKIE_NAME);
  return redirect;
}

export const config = {
  // Everything except Next's own static output and the favicon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
