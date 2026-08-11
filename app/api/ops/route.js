/**
 * Operations API — the everyday tasks, as server-built statements.
 *
 *   GET  /api/ops                    — states, tables, search fields, statuses, actions
 *   POST /api/ops  {kind:'search'}   — run a bounded SELECT and return rows
 *   POST /api/ops  {kind:'plan'}     — build an action's statement (does NOT run it)
 *
 * A plan is only ever a string of SQL. To actually run it the caller goes through
 * /api/query/preview and /api/query/execute like anything else, so an ops button
 * gets the same preview of affected rows and the same confirm token as a
 * hand-typed statement. There is deliberately no endpoint here that writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { requireSession } from '@/lib/session-server';
import {
  buildAction,
  buildSearch,
  listActions,
  loadStatuses,
  opsTablesFor,
  OpsActionError,
  OPS_TABLE_KEYS,
  SEARCH_FIELDS,
  NULLABLE_PATHS,
} from '@/lib/ops-actions';
import { runQuery, formatDbError, describeEndpoint } from '@/lib/db';

export const runtime = 'nodejs';

const TABLES_PATH = path.join(process.cwd(), 'data', 'tables.json');

/** State groups that actually define the ops tables, from the generated list. */
function opsStates() {
  const raw = JSON.parse(fs.readFileSync(TABLES_PATH, 'utf8'));
  const STATE_GROUPS = new Set([
    'KARNATAKA',
    'MP',
    'TELANGANA',
    'ANDHRA',
    'UP',
    'MAHARASHTRA',
    'OD',
    'TN',
    'RJ',
    'GJ',
    'CH',
    'TR',
    'AS',
  ]);

  return (raw.groups || [])
    .filter((g) => STATE_GROUPS.has(g.group))
    .map((g) => ({
      group: g.group,
      stateName: g.meta?.STATE || g.group,
      stateCode: g.meta?.STATE_CODE || null,
      tables: opsTablesFor(g.group),
    }))
    // Only offer a state where the applicant table actually resolves.
    .filter((s) => s.tables.length > 0);
}

export async function GET() {
  const { session, response } = await requireSession();
  if (!session) return response;

  try {
    return Response.json({
      ok: true,
      endpoint: describeEndpoint(),
      states: opsStates(),
      tableKeys: OPS_TABLE_KEYS,
      searchFields: SEARCH_FIELDS,
      statuses: loadStatuses(),
      nullablePaths: NULLABLE_PATHS,
      actions: listActions(),
    });
  } catch (err) {
    console.error('[ops] config load failed:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
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

  const kind = body?.kind;

  /* -------------------------------------------------------------- search */
  if (kind === 'search') {
    try {
      const built = buildSearch({
        stateGroup: body.state,
        tableKey: body.table,
        field: body.field,
        value: body.value,
        limit: body.limit,
      });

      const result = await runQuery(built.sql, { maxRows: 200 });

      console.log(
        `[ops] SEARCH user=${session.username} ${built.table}.${built.field}=` +
          `${built.value} rows=${result.rowCount}`
      );

      return Response.json({
        ok: true,
        sql: built.sql,
        table: built.table,
        tableKey: built.tableKey,
        rows: result.rows,
        rowCount: result.rowCount,
        elapsedMs: result.elapsedMs,
      });
    } catch (err) {
      if (err instanceof OpsActionError) {
        return Response.json({ error: err.message, code: err.code }, { status: 400 });
      }
      return Response.json({ error: formatDbError(err), code: 'SEARCH_FAILED' }, { status: 400 });
    }
  }

  /* ---------------------------------------------------------------- plan */
  if (kind === 'plan') {
    try {
      const built = buildAction(body.action, {
        stateGroup: body.state,
        id: body.id,
        status: body.status,
        path: body.path,
      });

      console.log(
        `[ops] PLAN user=${session.username} action=${body.action} table=${built.table}`
      );

      // Returned, not executed. The caller must still preview and confirm.
      return Response.json({ ok: true, ...built });
    } catch (err) {
      if (err instanceof OpsActionError) {
        return Response.json({ error: err.message, code: err.code }, { status: 400 });
      }
      console.error('[ops] plan failed:', err);
      return Response.json({ error: err.message, code: 'PLAN_FAILED' }, { status: 400 });
    }
  }

  return Response.json({ error: "kind must be 'search' or 'plan'" }, { status: 400 });
}
