/**
 * auth.js — session issuing/verification for UBI Ops.
 *
 * Deliberately NOT ubi-backend's CLOGIN / banker-role system: "which developer
 * may run raw queries and deploy builds" is a different question from bank-staff
 * privileges, and conflating them would grant ops powers along bank hierarchy.
 *
 * jose (not jsonwebtoken) so middleware.js can genuinely *verify* the signature
 * in the Edge runtime instead of merely observing that a cookie exists.
 */

import { SignJWT, jwtVerify } from 'jose';

export const COOKIE_NAME = 'ubi_ops_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12h — one working day

const ISSUER = 'ubi-ops';
const AUDIENCE = 'ubi-ops-console';

let cachedSecret = null;

/** Encoded JWT_SECRET. Throws loudly rather than falling back to a default. */
export function getSecret() {
  if (cachedSecret) return cachedSecret;
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      'JWT_SECRET missing or shorter than 32 chars — set it in .env.local'
    );
  }
  cachedSecret = new TextEncoder().encode(raw);
  return cachedSecret;
}

export async function createSessionToken(username) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: username })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_SECONDS)
    .sign(getSecret());
}

/** Returns { username } on success, or null. Never throws for a bad token. */
export async function verifySessionToken(token) {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    if (!payload.sub) return null;
    return { username: payload.sub };
  } catch {
    return null;
  }
}

export function sessionCookieOptions() {
  return {
    name: COOKIE_NAME,
    httpOnly: true,
    sameSite: 'strict',
    // The app is reached over an SSH tunnel to 127.0.0.1, i.e. plain HTTP.
    // `secure` would make the cookie undeliverable and lock everyone out.
    secure: false,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  };
}
