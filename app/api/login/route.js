import { cookies } from 'next/headers';
import { createSessionToken, sessionCookieOptions } from '@/lib/auth';
import { verifyCredentials } from '@/lib/session-server';

export const runtime = 'nodejs';

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Malformed request body' }, { status: 400 });
  }

  const { username, password } = body || {};
  const who = await verifyCredentials(username, password);

  if (!who) {
    console.log(`[auth] failed login attempt for username=${JSON.stringify(username)}`);
    // One message for both "no such user" and "wrong password".
    return Response.json({ error: 'Invalid username or password' }, { status: 401 });
  }

  const token = await createSessionToken(who);
  const { name, ...options } = sessionCookieOptions();
  cookies().set(name, token, options);

  console.log(`[auth] login ok user=${who}`);
  return Response.json({ ok: true, username: who });
}
