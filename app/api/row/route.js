/**
 * Key-based single-row operations.
 *
 *   POST   /api/row  {action:'get'}     — fetch one row by full primary key
 *   POST   /api/row  {action:'preview'} — fetch it + mint a confirm token
 *   PUT    /api/row                     — write a whole row back (put)
 *   DELETE /api/row                     — delete by full primary key
 *
 * These use the driver's get/put/delete rather than SQL text, mirroring
 * deleteQuery / deleteQueryV2..V4 in ubi-backend's sqlqueries.js. For the single
 * most common operation in this console — removing or fixing one applicant or
 * custid row — that is materially safer than a hand-written statement: there is
 * no clause to mistype and no chance of matching more rows than intended.
 */

import { requireSession } from '@/lib/session-server';
import {
  getTableMeta,
  getRowByKey,
  putRow,
  deleteRowByKey,
  formatDbError,
} from '@/lib/db';
import {
  createConfirmToken,
  verifyConfirmToken,
  rowConfirmPayload,
} from '@/lib/confirm-token';

export const runtime = 'nodejs';

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)*$/;

function badRequest(message) {
  return Response.json({ error: message }, { status: 400 });
}

/**
 * Validate that `key` supplies every primary key column and nothing else.
 *
 * A partial key is the dangerous case: the driver would either error or, worse,
 * operate on a different row than the operator has in mind. Extra fields are
 * rejected too, so a key object can never smuggle data into a delete.
 */
async function resolveKey(table, suppliedKey) {
  const meta = await getTableMeta(table);
  const pk = meta.primaryKey || [];

  if (pk.length === 0) {
    throw new Error(
      `Cannot determine the primary key of ${table}, so a key-based operation is unsafe here. ` +
        'Use a SQL statement with an explicit WHERE clause instead.'
    );
  }

  const key = {};
  const missing = [];
  for (const column of pk) {
    const value = suppliedKey?.[column];
    if (value === undefined || value === null || value === '') missing.push(column);
    else key[column] = value;
  }

  if (missing.length) {
    throw new Error(
      `Incomplete primary key for ${table}: missing ${missing.join(', ')}. ` +
        `The full key is (${pk.join(', ')}).`
    );
  }

  const extra = Object.keys(suppliedKey || {}).filter((k) => !pk.includes(k));
  if (extra.length) {
    throw new Error(`Not part of the primary key of ${table}: ${extra.join(', ')}`);
  }

  return { meta, key, primaryKey: pk };
}

export async function POST(request) {
  const { session, response } = await requireSession();
  if (!session) return response;

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Malformed request body');
  }

  const { action, table, key: suppliedKey } = body || {};
  if (typeof table !== 'string' || !TABLE_NAME_RE.test(table)) {
    return badRequest('Invalid table name');
  }
  if (action !== 'get' && action !== 'preview') {
    return badRequest("action must be 'get' or 'preview'");
  }

  try {
    const { meta, key, primaryKey } = await resolveKey(table, suppliedKey);
    const { row } = await getRowByKey(table, key);

    if (!row) {
      return Response.json(
        { ok: true, found: false, table, key, primaryKey },
        { status: 200 }
      );
    }

    const payload = {
      ok: true,
      found: true,
      table,
      key,
      primaryKey,
      fields: meta.fields,
      row,
    };

    if (action === 'preview') {
      // Separate tokens per action so a token minted to preview an edit cannot
      // authorise a delete of the same row.
      payload.updateToken = createConfirmToken(
        rowConfirmPayload({ action: 'update', table, key }),
        session.username
      );
      payload.deleteToken = createConfirmToken(
        rowConfirmPayload({ action: 'delete', table, key }),
        session.username
      );
    }

    return Response.json(payload);
  } catch (err) {
    return badRequest(formatDbError(err));
  }
}

export async function PUT(request) {
  const { session, response } = await requireSession();
  if (!session) return response;

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Malformed request body');
  }

  const { table, key: suppliedKey, row, confirmToken } = body || {};
  if (typeof table !== 'string' || !TABLE_NAME_RE.test(table)) {
    return badRequest('Invalid table name');
  }
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return badRequest('row must be an object');
  }

  try {
    const { key, primaryKey } = await resolveKey(table, suppliedKey);

    const check = verifyConfirmToken(
      confirmToken,
      rowConfirmPayload({ action: 'update', table, key }),
      session.username
    );
    if (!check.ok) {
      return Response.json({ error: check.reason, code: 'CONFIRMATION_REQUIRED' }, { status: 428 });
    }

    // The edited row must still identify the same record. Letting the primary key
    // change would silently create a second row and leave the original behind —
    // an "edit" that quietly duplicates instead of updating.
    for (const column of primaryKey) {
      if (String(row[column]) !== String(key[column])) {
        return badRequest(
          `Primary key column "${column}" cannot be changed by an edit ` +
            `(was ${key[column]}, got ${row[column]}). Delete and re-insert instead.`
        );
      }
    }

    console.log(
      `[row] UPDATE user=${session.username} table=${table} key=${JSON.stringify(key)}`
    );

    const result = await putRow(table, row);
    return Response.json({ ok: true, success: result.success, table, key });
  } catch (err) {
    return badRequest(formatDbError(err));
  }
}

export async function DELETE(request) {
  const { session, response } = await requireSession();
  if (!session) return response;

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('Malformed request body');
  }

  const { table, key: suppliedKey, confirmToken } = body || {};
  if (typeof table !== 'string' || !TABLE_NAME_RE.test(table)) {
    return badRequest('Invalid table name');
  }

  try {
    const { key } = await resolveKey(table, suppliedKey);

    const check = verifyConfirmToken(
      confirmToken,
      rowConfirmPayload({ action: 'delete', table, key }),
      session.username
    );
    if (!check.ok) {
      return Response.json({ error: check.reason, code: 'CONFIRMATION_REQUIRED' }, { status: 428 });
    }

    console.log(
      `[row] DELETE user=${session.username} table=${table} key=${JSON.stringify(key)}`
    );

    const result = await deleteRowByKey(table, key);
    return Response.json({
      ok: true,
      success: result.success,
      table,
      key,
      // Returned so the UI can show what was removed, and so the operator has
      // the row's contents to hand if the delete turns out to be a mistake.
      deletedRow: result.existingRow || null,
    });
  } catch (err) {
    return badRequest(formatDbError(err));
  }
}
