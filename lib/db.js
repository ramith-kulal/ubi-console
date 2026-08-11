/**
 * db.js — the single Oracle NoSQL client for this app.
 *
 * THE ENDPOINT IS HARDCODED AND MUST STAY THAT WAY.
 *
 * `http://localhost:8086` is not configuration; it is a safety property. There
 * is no env var and no config key that can repoint this tool at another store,
 * which is what makes production unreachable by construction rather than by
 * policy. Production lives at a different host entirely and this app must never
 * be able to name it. Do not "improve" this into a setting.
 *
 * Mirrors ubi-backend/src/database/connection.js for connection style: KVSTORE
 * service type, non-secure mode (the store has no credentials), 120s timeout.
 */

import { NoSQLClient, ServiceType } from 'oracle-nosqldb';
import {
  analyzeQuery,
  CHANNEL_QUERY,
  CHANNEL_TABLE_DDL,
  CHANNEL_ADMIN_DDL,
  DEFAULT_ROW_LIMIT,
} from './query-guard.js';

const ENDPOINT = 'http://localhost:8086';

/** Hard ceiling on rows pulled into memory, whatever the statement asks for. */
export const MAX_ROWS = 2000;

/**
 * Short timeout for metadata and liveness calls.
 *
 * The client's 120s timeout is right for a real query that scans a large table,
 * but applying it to a getTable() lookup means that when the proxy is down every
 * screen hangs for two minutes instead of saying "the database is unreachable".
 * Fast failure on the cheap calls, patience on the expensive one.
 */
const METADATA_TIMEOUT_MS = 8000;

let client = null;

/**
 * Module-scope singleton. The driver pools connections internally, so creating
 * one per request would leak sockets against a store that also serves the
 * production backend on this box.
 */
export function getClient() {
  if (client) return client;
  client = new NoSQLClient({
    serviceType: ServiceType.KVSTORE,
    endpoint: ENDPOINT,
    timeout: 120000,
  });
  return client;
}

export function describeEndpoint() {
  return ENDPOINT;
}

/**
 * Turn a driver error into something an operator can act on.
 * The raw errors are long and lead with Java-ish class names.
 */
export function formatDbError(err) {
  const message = err && err.message ? err.message : String(err);

  if (/ECONNREFUSED|connect failed|NoSQLNetworkError/i.test(message)) {
    return (
      `Cannot reach the database at ${ENDPOINT}. On the instance, check that the ` +
      'Oracle NoSQL proxy is running and listening on 8086.'
    );
  }
  if (/Table .* (does not exist|not found)/i.test(message)) {
    return `${message} — check the table name against the browser on the left.`;
  }
  return message;
}

/**
 * Run a SELECT (or any query()-channel statement) and page through results.
 *
 * Stops as soon as the row cap is reached rather than draining the whole
 * continuation chain: the point of the cap is to avoid pulling a million
 * applicant rows into a Node process, so continuing to page "just to count"
 * would defeat it.
 */
export async function runQuery(sql, { maxRows = MAX_ROWS } = {}) {
  const nosql = getClient();
  const startedAt = Date.now();

  const rows = [];
  let continuationKey = null;
  let truncated = false;

  do {
    const options = continuationKey ? { continuationKey } : {};
    // eslint-disable-next-line no-await-in-loop
    const result = await nosql.query(sql, options);

    for (const row of result.rows || []) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      rows.push(row);
    }

    continuationKey = truncated ? null : result.continuationKey || null;
  } while (continuationKey);

  return {
    rows,
    rowCount: rows.length,
    truncated,
    elapsedMs: Date.now() - startedAt,
  };
}

/** Execute a table DDL statement and wait for the table to settle. */
export async function runTableDdl(sql) {
  const nosql = getClient();
  const startedAt = Date.now();

  const result = await nosql.tableDDL(sql, { complete: true });

  return {
    rows: [],
    rowCount: 0,
    elapsedMs: Date.now() - startedAt,
    tableState: result?.tableState ?? null,
    tableName: result?.tableName ?? null,
    ddl: true,
  };
}

/** Execute an admin (security / namespace) statement and wait for completion. */
export async function runAdminDdl(sql) {
  const nosql = getClient();
  const startedAt = Date.now();

  const result = await nosql.adminDDL(sql, { complete: true });

  // adminDDL output is a JSON blob for SHOW/DESCRIBE and empty for GRANT etc.
  let output = null;
  if (result && result.output) {
    try {
      output = JSON.parse(result.output);
    } catch {
      output = result.output;
    }
  }

  return {
    rows: [],
    rowCount: 0,
    elapsedMs: Date.now() - startedAt,
    adminState: result?.state ?? null,
    output,
    ddl: true,
  };
}

/**
 * Dispatch a statement to the channel query-guard chose.
 *
 * Oracle NoSQL rejects DDL sent through query(), so this routing is what makes
 * DROP/CREATE/GRANT work at all — it is not a stylistic split.
 */
export async function executeStatement(sql, { maxRows = MAX_ROWS } = {}) {
  const verdict = analyzeQuery(sql);
  if (verdict.blocked) {
    const error = new Error(verdict.reason);
    error.code = verdict.code;
    throw error;
  }

  switch (verdict.channel) {
    case CHANNEL_TABLE_DDL:
      return { ...(await runTableDdl(verdict.executable)), verdict };
    case CHANNEL_ADMIN_DDL:
      return { ...(await runAdminDdl(verdict.executable)), verdict };
    case CHANNEL_QUERY:
    default:
      return { ...(await runQuery(verdict.executable, { maxRows })), verdict };
  }
}

/* ------------------------------------------------------------ table metadata */

const tableMetaCache = new Map();

/**
 * Primary key and field list for a table, asked of the database rather than
 * hardcoded — the schemas in ubi-backend drift, and a wrong primary key here
 * would mean a row edit silently writing a new row instead of updating one.
 *
 * Returns { name, primaryKey: [...], shardKey: [...], fields: [{name, type}] }.
 */
export async function getTableMeta(tableName) {
  if (tableMetaCache.has(tableName)) return tableMetaCache.get(tableName);

  const nosql = getClient();
  const result = await nosql.getTable(tableName, { timeout: METADATA_TIMEOUT_MS });

  let primaryKey = [];
  let shardKey = [];
  let fields = [];

  if (result.schema) {
    try {
      const schema = JSON.parse(result.schema);
      primaryKey = schema.primaryKey || schema.primaryKeyFields || [];
      shardKey = schema.shardKey || [];
      fields = (schema.fields || []).map((f) => ({
        name: f.name,
        type: typeof f.type === 'string' ? f.type : JSON.stringify(f.type),
        nullable: f.nullable !== false,
      }));
    } catch {
      /* fall through to the DDL parse below */
    }
  }

  // Fallback: read PRIMARY KEY (...) out of the CREATE TABLE statement.
  if (primaryKey.length === 0 && result.tableDDL) {
    const match = result.tableDDL.match(/PRIMARY\s+KEY\s*\(([^)]*)\)/i);
    if (match) {
      primaryKey = match[1]
        // SHARD(...) wraps part of the key in some definitions.
        .replace(/SHARD\s*\(([^)]*)\)/gi, '$1')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const meta = {
    name: result.tableName || tableName,
    tableState: result.tableState,
    primaryKey,
    shardKey,
    fields,
    ddl: result.tableDDL || null,
  };

  tableMetaCache.set(tableName, meta);
  return meta;
}

/** Clear cached metadata — call after a DDL statement changes a table. */
export function invalidateTableMeta(tableName) {
  if (tableName) tableMetaCache.delete(tableName);
  else tableMetaCache.clear();
}

/* ----------------------------------------------------- key-based row access */

/**
 * Fetch one row by its full primary key.
 * Safer than SQL text for the single-row case: no parsing, no clause to get wrong.
 */
export async function getRowByKey(tableName, key) {
  const nosql = getClient();
  const result = await nosql.get(tableName, key);
  return { row: result.row || null, version: result.version || null };
}

/**
 * Replace a row via the driver's put().
 *
 * Mirrors the `nosqldbConnection.put(tableName, data, {})` pattern in
 * ubi-backend/src/database/sqlqueries.js. Note this is a whole-row write, so the
 * caller must send the complete row, not a partial patch — otherwise omitted
 * fields are dropped.
 */
export async function putRow(tableName, row) {
  const nosql = getClient();
  const result = await nosql.put(tableName, row);
  return { success: Boolean(result.version), version: result.version || null };
}

/**
 * Delete one row by full primary key, mirroring deleteQuery/deleteQueryV2..V4 in
 * sqlqueries.js. This is the safest form of the most common operation in this
 * console — removing a single applicant or custid row.
 */
export async function deleteRowByKey(tableName, key) {
  const nosql = getClient();
  const result = await nosql.delete(tableName, key);
  return { success: Boolean(result.success), existingRow: result.existingRow || null };
}

/**
 * Is this store reachable? Used by the console header so a connection problem
 * reads as "the database is down", not "your query is wrong".
 */
export async function ping() {
  try {
    const nosql = getClient();
    await nosql.listTables({ limit: 1, timeout: METADATA_TIMEOUT_MS });
    return { ok: true, endpoint: ENDPOINT };
  } catch (err) {
    return { ok: false, endpoint: ENDPOINT, error: formatDbError(err) };
  }
}

export { DEFAULT_ROW_LIMIT };
