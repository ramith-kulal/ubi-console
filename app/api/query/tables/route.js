/**
 * GET /api/query/tables            — the table browser tree, grouped by state
 * GET /api/query/tables?table=NAME — primary key and field list for one table
 *
 * The tree comes from data/tables.json (generated from ubi-backend by
 * scripts/gen-tables.js), and is cross-referenced against the store's live
 * listTables() so the UI can show which configured tables actually exist here.
 */

import fs from 'node:fs';
import path from 'node:path';
import { requireSession } from '@/lib/session-server';
import { getClient, getTableMeta, formatDbError, describeEndpoint } from '@/lib/db';

export const runtime = 'nodejs';

const TABLES_PATH = path.join(process.cwd(), 'data', 'tables.json');

/**
 * Groups that are states, in the order an operator thinks of them. Everything
 * else in DATA_TABLES (SATSURE, PROFILE, CIBIL, image tables…) is real but is
 * not a state, so it is listed separately rather than mixed in.
 */
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

let treeCache = null;

function loadTree() {
  if (treeCache) return treeCache;

  const raw = JSON.parse(fs.readFileSync(TABLES_PATH, 'utf8'));

  const groups = (raw.groups || []).map((g) => ({
    group: g.group,
    kind: g.group === 'GENERAL' ? 'general' : STATE_GROUPS.has(g.group) ? 'state' : 'other',
    stateName: g.meta?.STATE || null,
    stateCode: g.meta?.STATE_CODE || null,
    tables: g.tables,
  }));

  // States first, then GENERAL, then the rest — the order the left rail renders.
  const rank = { state: 0, general: 1, other: 2 };
  groups.sort((a, b) => rank[a.kind] - rank[b.kind] || a.group.localeCompare(b.group));

  treeCache = {
    groups,
    // Surfaced so the UI can warn: GENERAL is spread last in ubi-backend's merge
    // and silently overrides these state-suffixed keys.
    shadowedByGeneral: raw.shadowedByGeneral || [],
    generatedFrom: raw.source || null,
  };
  return treeCache;
}

/** Table names that actually exist in this store. Null if the DB is unreachable. */
async function listLiveTables() {
  try {
    const nosql = getClient();
    const names = [];
    let startIndex = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const result = await nosql.listTables({ startIndex, limit: 500, timeout: 8000 });
      const batch = result.tableNames || [];
      names.push(...batch);
      if (batch.length === 0 || names.length >= 5000) break;
      startIndex = result.lastIndex ?? startIndex + batch.length;
      if (batch.length < 500) break;
    }
    return new Set(names.map((n) => n.toUpperCase()));
  } catch {
    return null;
  }
}

export async function GET(request) {
  const { session, response } = await requireSession();
  if (!session) return response;

  const requested = new URL(request.url).searchParams.get('table');

  /* ---- single table metadata ---- */
  if (requested) {
    // Only a plausible table identifier ever reaches the driver.
    if (!/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*$/.test(requested)) {
      return Response.json({ error: 'Invalid table name' }, { status: 400 });
    }
    try {
      const meta = await getTableMeta(requested);
      return Response.json({ ok: true, meta });
    } catch (err) {
      return Response.json({ error: formatDbError(err) }, { status: 400 });
    }
  }

  /* ---- the whole tree ---- */
  try {
    const tree = loadTree();
    const live = await listLiveTables();

    const groups = tree.groups.map((g) => ({
      ...g,
      tables: g.tables.map((t) => ({
        ...t,
        // null when we could not reach the DB, so the UI shows "unknown" rather
        // than falsely claiming a table is missing.
        exists: live ? live.has(t.name.toUpperCase()) : null,
      })),
    }));

    return Response.json({
      ok: true,
      endpoint: describeEndpoint(),
      dbReachable: live !== null,
      liveTableCount: live ? live.size : null,
      shadowedByGeneral: tree.shadowedByGeneral,
      groups,
    });
  } catch (err) {
    console.error('[query] tables listing failed:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
