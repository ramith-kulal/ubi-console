/**
 * Saved queries — CRUD over saved-queries.json.
 *
 * There is deliberately no "run" here. Clicking a saved query loads it into the
 * editor and nothing more, so no destructive statement is ever one click from
 * executing. Whoever runs it still goes through preview and confirmation.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireSession } from '@/lib/session-server';
import { analyzeQuery } from '@/lib/query-guard';

export const runtime = 'nodejs';

const STORE_PATH = path.join(process.cwd(), 'saved-queries.json');
const MAX_QUERIES = 500;
const MAX_SQL_LENGTH = 20000;

async function readStore() {
  if (!fs.existsSync(STORE_PATH)) return [];
  try {
    const parsed = JSON.parse(await fsp.readFile(STORE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('[saved] saved-queries.json is unreadable:', err.message);
    return [];
  }
}

async function writeStore(entries) {
  await fsp.writeFile(STORE_PATH, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

export async function GET() {
  const { session, response } = await requireSession();
  if (!session) return response;

  const entries = await readStore();

  // Annotate each entry with what it would do, so the list can show a DELETE
  // badge before anyone opens it.
  return Response.json({
    ok: true,
    queries: entries.map((q) => {
      const verdict = analyzeQuery(q.sql || '');
      return {
        ...q,
        statementType: verdict.blocked ? null : verdict.type,
        risk: verdict.blocked ? null : verdict.risk,
        blocked: verdict.blocked,
      };
    }),
  });
}

export async function POST(request) {
  const { session, response } = await requireSession();
  if (!session) return response;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Malformed request body' }, { status: 400 });
  }

  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const sql = typeof body?.sql === 'string' ? body.sql : '';

  if (!name) return Response.json({ error: 'A name is required' }, { status: 400 });
  if (name.length > 120) {
    return Response.json({ error: 'Name is too long (max 120 chars)' }, { status: 400 });
  }
  if (!sql.trim()) return Response.json({ error: 'Query text is required' }, { status: 400 });
  if (sql.length > MAX_SQL_LENGTH) {
    return Response.json({ error: 'Query text is too long' }, { status: 400 });
  }

  const entries = await readStore();
  if (entries.length >= MAX_QUERIES) {
    return Response.json({ error: `Limit of ${MAX_QUERIES} saved queries reached` }, { status: 400 });
  }

  const entry = {
    id: crypto.randomUUID(),
    name,
    sql,
    savedBy: session.username,
    savedAt: new Date().toISOString(),
  };

  entries.push(entry);
  await writeStore(entries);

  return Response.json({ ok: true, query: entry });
}

export async function PUT(request) {
  const { session, response } = await requireSession();
  if (!session) return response;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Malformed request body' }, { status: 400 });
  }

  const { id, name, sql } = body || {};
  if (typeof id !== 'string' || !id) {
    return Response.json({ error: 'id is required' }, { status: 400 });
  }

  const entries = await readStore();
  const index = entries.findIndex((q) => q.id === id);
  if (index === -1) return Response.json({ error: 'No such saved query' }, { status: 404 });

  if (typeof name === 'string' && name.trim()) entries[index].name = name.trim();
  if (typeof sql === 'string' && sql.trim()) {
    if (sql.length > MAX_SQL_LENGTH) {
      return Response.json({ error: 'Query text is too long' }, { status: 400 });
    }
    entries[index].sql = sql;
  }
  entries[index].updatedBy = session.username;
  entries[index].updatedAt = new Date().toISOString();

  await writeStore(entries);
  return Response.json({ ok: true, query: entries[index] });
}

export async function DELETE(request) {
  const { session, response } = await requireSession();
  if (!session) return response;

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

  const entries = await readStore();
  const remaining = entries.filter((q) => q.id !== id);
  if (remaining.length === entries.length) {
    return Response.json({ error: 'No such saved query' }, { status: 404 });
  }

  await writeStore(remaining);
  return Response.json({ ok: true });
}
