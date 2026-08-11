/**
 * POST /api/query/preview — show exactly what a statement would affect.
 *
 * For UPDATE/DELETE this runs the guard's generated SELECT and returns the real
 * matched rows. For INSERT and DDL no preview can exist, so it returns the note
 * explaining why plus the confirm token.
 *
 * Nothing is written here under any circumstance.
 */

import { requireSession } from '@/lib/session-server';
import { analyzeQuery, PREVIEW_LIMIT } from '@/lib/query-guard';
import { createConfirmToken, queryConfirmPayload } from '@/lib/confirm-token';
import { runQuery, formatDbError, getTableMeta } from '@/lib/db';

export const runtime = 'nodejs';

/** Above this many matched rows the UI additionally demands a typed table name. */
const TYPED_CONFIRMATION_THRESHOLD = 50;

export async function POST(request) {
  const { session, response } = await requireSession();
  if (!session) return response;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Malformed request body' }, { status: 400 });
  }

  const sql = typeof body?.sql === 'string' ? body.sql : '';
  const verdict = analyzeQuery(sql);

  if (verdict.blocked) {
    return Response.json({ error: verdict.reason, code: verdict.code }, { status: 400 });
  }

  // A SELECT has nothing to confirm — the caller should just execute it.
  if (!verdict.requiresConfirmation) {
    return Response.json({
      ok: true,
      type: verdict.type,
      requiresConfirmation: false,
      effectiveLimit: verdict.effectiveLimit,
      limitApplied: verdict.limitApplied,
    });
  }

  const token = createConfirmToken(
    queryConfirmPayload({ normalizedSql: verdict.normalized }),
    session.username
  );

  const base = {
    ok: true,
    type: verdict.type,
    risk: verdict.risk,
    channel: verdict.channel,
    table: verdict.table || null,
    where: verdict.where || null,
    normalized: verdict.normalized,
    requiresConfirmation: true,
    requiresTypedConfirmation: Boolean(verdict.requiresTypedConfirmation),
    typedConfirmationValue: verdict.typedConfirmationValue || verdict.table || null,
    previewNote: verdict.previewNote || null,
    confirmToken: token,
  };

  // INSERT / DDL: no rows to show.
  if (!verdict.previewSql) {
    return Response.json(base);
  }

  /* ---- UPDATE / DELETE: run the generated SELECT ---- */
  try {
    const result = await runQuery(verdict.previewSql, { maxRows: PREVIEW_LIMIT });

    // PREVIEW_LIMIT is 501, so hitting it means "500 or more" rather than a count.
    const atCap = result.rowCount >= PREVIEW_LIMIT;
    const matchedRows = atCap ? result.rows.slice(0, PREVIEW_LIMIT - 1) : result.rows;

    let primaryKey = [];
    try {
      const meta = await getTableMeta(verdict.table);
      primaryKey = meta.primaryKey;
    } catch {
      /* metadata is a nicety here; a preview must not fail because of it */
    }

    console.log(
      `[query] PREVIEW user=${session.username} type=${verdict.type} ` +
        `table=${verdict.table} matched=${atCap ? '500+' : result.rowCount}`
    );

    return Response.json({
      ...base,
      previewSql: verdict.previewSql,
      rows: matchedRows,
      rowCount: matchedRows.length,
      countLabel: atCap ? '500+' : String(matchedRows.length),
      atCap,
      primaryKey,
      elapsedMs: result.elapsedMs,
      // Typing the table name is required when the blast radius is large, or
      // whenever the statement is irreversible DDL.
      requiresTypedConfirmation:
        Boolean(verdict.requiresTypedConfirmation) ||
        atCap ||
        matchedRows.length > TYPED_CONFIRMATION_THRESHOLD,
    });
  } catch (err) {
    console.error('[query] preview failed:', err);
    return Response.json(
      { error: formatDbError(err), code: 'PREVIEW_FAILED' },
      { status: 400 }
    );
  }
}
