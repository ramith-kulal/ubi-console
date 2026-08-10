/**
 * session-server.js — Node-runtime session helpers.
 *
 * Split from lib/auth.js because this file touches `fs` and `bcryptjs` (the
 * users.json credential store), which cannot run in the Edge middleware.
 */

import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { cookies } from 'next/headers';
import { COOKIE_NAME, verifySessionToken } from './auth.js';

const USERS_PATH = path.join(process.cwd(), 'users.json');

function readUsers() {
  if (!fs.existsSync(USERS_PATH)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[auth] users.json is unreadable/corrupt:', err.message);
    return [];
  }
}

/**
 * Verify a username/password pair. Returns the username on success, else null.
 * Runs a bcrypt comparison even when the user does not exist so that a missing
 * account and a wrong password take comparable time.
 */
export async function verifyCredentials(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string') return null;
  const users = readUsers();
  const found = users.find((u) => u && u.username === username);
  const hash =
    (found && found.passwordHash) ||
    // Cost-10 hash of a value no one can supply; result is discarded.
    '$2a$10$0000000000000000000000000000000000000000000000000000';

  let ok = false;
  try {
    ok = await bcrypt.compare(password, hash);
  } catch {
    ok = false;
  }
  return ok && found ? found.username : null;
}

/** Current session from the request cookie, or null. */
export async function getSession() {
  const token = cookies().get(COOKIE_NAME)?.value;
  return verifySessionToken(token);
}

/**
 * Session or a 401 Response. Every API route that touches the DB or the
 * filesystem calls this — middleware is defence in depth, not the only gate.
 */
export async function requireSession() {
  const session = await getSession();
  if (!session) {
    return {
      session: null,
      response: new Response(JSON.stringify({ error: 'Not authenticated' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    };
  }
  return { session, response: null };
}
