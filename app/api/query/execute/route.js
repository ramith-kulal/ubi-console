/**
 * POST /api/query/execute — run a statement.
 *
 * A read runs immediately. Anything that writes requires a confirm token bound
 * to this exact statement text, so the rows a user approved in the preview are
 * the rows the statement touches. Re-analysing here rather than trusting the
 * client is the whole point: the browser's verdict is a convenience for the
 * badge, never an authorisation.
 */

import { requireSession } from '@/lib/session-server';
import { analyzeQuery } from '@/lib/query-guard';
import { verifyConfirmToken, queryConfirmPayload } from '@/lib/confirm-token';
import { executeStatement, formatDbError, invalidateTableMeta, MAX_ROWS } from '@/lib/db';

export const runtime = 'nodejs';
export const maxDuration = 180;

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

  if (verdict.requiresConfirmation) {
    const check = verifyConfirmToken(
      body?.confirmToken,
      queryConfirmPayload({ normalizedSql: verdict.normalized }),
      session.username
    );
    if (!check.ok) {
      // 428: the caller must go through /preview first.
      return Response.json(
        {
          error: check.reason,
          code: 'CONFIRMATION_REQUIRED',
          requiresConfirmation: true,
        },
        { status: 428 }
      );
    }
  }

  console.log(
    `[query] EXECUTE user=${session.username} type=${verdict.type} ` +
      `channel=${verdict.channel} sql=${verdict.normalized.replace(/\s+/g, ' ').slice(0, 300)}`
  );

  try {
    const result = await executeStatement(verdict.normalized, { maxRows: MAX_ROWS });

    // A schema change makes any cached primary key / field list wrong.
    if (result.ddl) invalidateTableMeta(verdict.table || null);

    return Response.json({
      ok: true,
      type: verdict.type,
      risk: verdict.risk,
      channel: verdict.channel,
      executed: verdict.executable,
      limitApplied: Boolean(verdict.limitApplied),
      effectiveLimit: verdict.effectiveLimit ?? null,
      rows: result.rows || [],
      rowCount: result.rowCount || 0,
      truncated: Boolean(result.truncated),
      elapsedMs: result.elapsedMs,
      ddl: Boolean(result.ddl),
      tableState: result.tableState ?? null,
      adminOutput: result.output ?? null,
    });
  } catch (err) {
    console.error('[query] execute failed:', err);
    return Response.json(
      { error: formatDbError(err), code: err.code || 'EXECUTE_FAILED' },
      { status: 400 }
    );
  }
}
