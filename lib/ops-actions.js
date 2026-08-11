/**
 * ops-actions.js — the canonical set of everyday operations, as SQL builders.
 *
 * Why the statements are built here and not in the browser:
 *
 * The Terminal screen already lets an authenticated user run arbitrary SQL, so
 * client-authored SQL would not be a privilege escalation. The reason to build
 * it server-side is correctness. A custId typed into a search box and dropped
 * into a template by string concatenation can break out of its literal and
 * change which rows the WHERE matches — turning "fix this one applicant" into
 * something much wider. Here every value is escaped once, in one place, and the
 * shapes are fixed.
 *
 * Every action below produces a statement that then goes through the ordinary
 * /api/query/preview → confirm → /api/query/execute path. Nothing here writes to
 * the database, and there is deliberately no shortcut that skips the preview.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Tables the Operations screen works with. Everything else is Terminal work. */
export const OPS_TABLE_KEYS = ['APPLICANTS_NEW_LOAN_CASES', 'CUSTID_DETAILS', 'CLOGIN'];

const STATUSES_PATH = path.join(process.cwd(), 'data', 'app-statuses.json');
const TABLES_PATH = path.join(process.cwd(), 'data', 'tables.json');

/* ------------------------------------------------------------------ escaping */

/**
 * A single-quoted SQL string literal.
 *
 * Doubling embedded quotes is the escape this dialect uses. Control characters
 * are stripped rather than escaped: they have no legitimate place in a custId or
 * account number, and leaving them in makes a statement that is hard to read in
 * the preview — which is where a human is supposed to catch a mistake.
 */
export function quoteLiteral(value) {
  const text = String(value ?? '').replace(/[\x00-\x1f\x7f]/g, '');
  return `'${text.replace(/'/g, "''")}'`;
}

/**
 * Values used in an identity lookup must look like an identifier.
 *
 * This is a whitelist, not sanitisation: anything outside the set is refused
 * outright rather than cleaned up and used anyway. Real custIds, UUIDs, account
 * numbers and mobile numbers all fit comfortably.
 */
const SAFE_VALUE_RE = /^[A-Za-z0-9_.@-]{1,128}$/;

export function assertSafeValue(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new OpsActionError(`${label} is required`);
  if (!SAFE_VALUE_RE.test(text)) {
    throw new OpsActionError(
      `${label} contains characters that are not allowed here ` +
        '(letters, digits, and . _ - @ only). Use the Terminal for anything unusual.'
    );
  }
  return text;
}

export class OpsActionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'OpsActionError';
    this.code = code || 'INVALID_ACTION';
  }
}

/* -------------------------------------------------------------- config loading */

let statusCache = null;

/** The appStatus values that may be set, generated from ubi-backend constants. */
export function loadStatuses() {
  if (statusCache) return statusCache;
  const raw = JSON.parse(fs.readFileSync(STATUSES_PATH, 'utf8'));
  statusCache = raw.statuses || [];
  return statusCache;
}

export function isKnownStatus(value) {
  return loadStatuses().some((s) => s.value === value);
}

let tablesCache = null;

function loadTables() {
  if (tablesCache) return tablesCache;
  tablesCache = JSON.parse(fs.readFileSync(TABLES_PATH, 'utf8'));
  return tablesCache;
}

/**
 * Resolve a (state, logical table) pair to the physical table name.
 *
 * This is the whole reason the ops screen asks for a state first: APPLICANT is
 * `APPLICANT` in Karnataka but `APPLICANT_MP` in Madhya Pradesh, and getting it
 * wrong means editing the wrong state's data. The mapping comes from the
 * generated table list, never from the client.
 */
export function resolveTable(stateGroup, tableKey) {
  const tables = loadTables();
  const group = (tables.groups || []).find((g) => g.group === stateGroup);
  if (!group) {
    throw new OpsActionError(`Unknown state group: ${stateGroup}`, 'UNKNOWN_STATE');
  }

  const entry = group.tables.find((t) => t.key === tableKey && t.kind === 'table');
  if (!entry) {
    // Fall back to GENERAL, where shared tables like CUSTID_DETAILS live.
    const general = (tables.groups || []).find((g) => g.group === 'GENERAL');
    const shared = general?.tables.find((t) => t.key === tableKey && t.kind === 'table');
    if (shared) return { table: shared.name, from: 'GENERAL', alias: shared.alias || null };
    throw new OpsActionError(
      `${tableKey} is not defined for ${stateGroup}`,
      'UNKNOWN_TABLE'
    );
  }

  return { table: entry.name, from: stateGroup, alias: entry.alias || null };
}

/** The three tables the ops screen exposes, resolved for a state. */
export function opsTablesFor(stateGroup) {
  const out = [];
  for (const key of OPS_TABLE_KEYS) {
    try {
      const resolved = resolveTable(stateGroup, key);
      out.push({ key, ...resolved });
    } catch {
      /* a state that genuinely lacks the table is simply not offered */
    }
  }
  return out;
}

/* ------------------------------------------------------------------- searching */

/**
 * Search fields per logical table, from the real schemas in
 * ubi-backend/src/database/schemas.
 */
export const SEARCH_FIELDS = {
  APPLICANTS_NEW_LOAN_CASES: [
    'custId',
    'id',
    'acc_no',
    'mobile_no',
    'applicant_name',
    'loanAccountNo',
    'ubi_reference_no',
    'appStatus',
    'branch_code',
    'state',
  ],
  CUSTID_DETAILS: ['custId', 'acc_no', 'mobile_no', 'loan_acc_no', 'id', 'state'],
  CLOGIN: ['userName', 'mobileNo', 'email', 'staffId', 'branchOrRlhId', 'id'],
};

/** Numeric columns must not be quoted, or the comparison silently matches nothing. */
const NUMERIC_FIELDS = new Set(['mobileNo', 'status', 'roleId', 'otp_counter']);

/**
 * Paths that may be nulled or emptied from the Operations screen.
 *
 * An allowlist rather than a free-text path box. Two reasons: a typo'd path in
 * this dialect does not error, it silently creates a new key — so a "reset" that
 * quietly does nothing is the likely failure — and nulling something like
 * `appStatus` or `custId` would break the row rather than reset it. Anything not
 * listed here is Terminal work, where the statement is visible in full.
 *
 * `clear` is the empty value a path should take: [] for file arrays that the
 * application iterates over, null for whole objects it null-checks.
 */
export const NULLABLE_PATHS = [
  { path: 'docs', clear: 'null', label: 'docs (entire object)' },
  { path: 'docs.assets', clear: 'null', label: 'docs.assets' },
  { path: 'docs.assets.bhoomi', clear: 'null', label: 'docs.assets.bhoomi' },
  { path: 'docs.assets.bhoomi.files', clear: '[]', label: 'docs.assets.bhoomi.files' },
  { path: 'docs.assets.bhoomi_land', clear: 'null', label: 'docs.assets.bhoomi_land' },
  { path: 'docs.assets.bhoomi_land.files', clear: '[]', label: 'docs.assets.bhoomi_land.files' },
  { path: 'docs.assets.satSure', clear: 'null', label: 'docs.assets.satSure' },
  { path: 'docs.assets.satSure.input', clear: '[]', label: 'docs.assets.satSure.input' },
  { path: 'docs.id', clear: 'null', label: 'docs.id (identity documents)' },
  { path: 'trackerObj', clear: 'null', label: 'trackerObj' },
  { path: 'profile', clear: 'null', label: 'profile' },
  { path: 'crifReport', clear: '[]', label: 'crifReport' },
  { path: 'creditReport', clear: '[]', label: 'creditReport' },
  { path: 'statusLog', clear: '[]', label: 'statusLog' },
  { path: 'loanProposedData', clear: 'null', label: 'loanProposedData' },
  { path: 'croppingPatternProposed', clear: 'null', label: 'croppingPatternProposed' },
  { path: 'addDocs', clear: '[]', label: 'addDocs' },
];

const NULLABLE_BY_PATH = new Map(NULLABLE_PATHS.map((p) => [p.path, p]));

export function isNullablePath(candidate) {
  return NULLABLE_BY_PATH.has(candidate);
}

/**
 * Build the listing query.
 *
 * An empty value means "show me everything" — the screen opens on the table's
 * contents rather than an empty box, which is how the team actually works: look
 * first, then narrow. The LIMIT is always present, so "everything" is still a
 * bounded page and never a full-table scan into a browser tab.
 */
export function buildSearch({ stateGroup, tableKey, field, value, limit = 50 }) {
  if (!OPS_TABLE_KEYS.includes(tableKey)) {
    throw new OpsActionError(`Not an Operations table: ${tableKey}`, 'UNKNOWN_TABLE');
  }

  const { table } = resolveTable(stateGroup, tableKey);
  const rowLimit = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;

  const hasFilter = value !== undefined && value !== null && String(value).trim() !== '';

  if (!hasFilter) {
    return {
      sql: `SELECT * FROM ${table} t LIMIT ${rowLimit}`,
      table,
      tableKey,
      field: null,
      value: null,
      filtered: false,
    };
  }

  const allowed = SEARCH_FIELDS[tableKey] || [];
  if (!allowed.includes(field)) {
    throw new OpsActionError(
      `Cannot search ${tableKey} by "${field}". Allowed: ${allowed.join(', ')}`,
      'BAD_FIELD'
    );
  }

  const safeValue = assertSafeValue(value, field);
  const literal = NUMERIC_FIELDS.has(field) ? Number(safeValue) : quoteLiteral(safeValue);

  if (NUMERIC_FIELDS.has(field) && Number.isNaN(literal)) {
    throw new OpsActionError(`${field} must be a number`, 'BAD_VALUE');
  }

  return {
    sql: `SELECT * FROM ${table} t WHERE t.${field}=${literal} LIMIT ${rowLimit}`,
    table,
    tableKey,
    field,
    value: safeValue,
    filtered: true,
  };
}

/* -------------------------------------------------------------------- actions */

/**
 * The action registry.
 *
 * Each builder receives validated params and returns { sql, summary, table }.
 * Every statement carries a WHERE on the row's primary key — query-guard would
 * refuse it otherwise, and that refusal is a feature: it means no action here
 * can be written in a way that touches more than the row on screen.
 */
export const ACTIONS = {
  'set-app-status': {
    label: 'Set application status',
    tableKey: 'APPLICANTS_NEW_LOAN_CASES',
    destructive: false,
    build({ stateGroup, id, status }) {
      const safeId = assertSafeValue(id, 'id');
      if (!isKnownStatus(status)) {
        throw new OpsActionError(
          `"${status}" is not a known appStatus. Re-run scripts/gen-app-statuses.js ` +
            'if the backend added one.',
          'UNKNOWN_STATUS'
        );
      }
      const { table } = resolveTable(stateGroup, 'APPLICANTS_NEW_LOAN_CASES');
      return {
        table,
        summary: `Set appStatus to "${status}" on 1 applicant row`,
        sql:
          `UPDATE ${table} a SET a.appStatus=${quoteLiteral(status)} ` +
          `WHERE a.id=${quoteLiteral(safeId)}`,
      };
    },
  },

  'clear-path': {
    label: 'Clear / null a field',
    tableKey: 'APPLICANTS_NEW_LOAN_CASES',
    destructive: true,
    /** Needs a path chosen from NULLABLE_PATHS; the UI renders that as a dropdown. */
    needsPath: true,
    build({ stateGroup, id, path: fieldPath }) {
      const safeId = assertSafeValue(id, 'id');
      const spec = NULLABLE_BY_PATH.get(fieldPath);
      if (!spec) {
        throw new OpsActionError(
          `"${fieldPath}" is not a field this screen may clear. ` +
            `Allowed: ${NULLABLE_PATHS.map((p) => p.path).join(', ')}`,
          'BAD_PATH'
        );
      }
      const { table } = resolveTable(stateGroup, 'APPLICANTS_NEW_LOAN_CASES');
      // The path comes from the allowlist, never from the request, so it is not
      // interpolated user input even though it looks like it.
      return {
        table,
        summary: `Set ${spec.path} to ${spec.clear} on 1 row`,
        sql:
          `UPDATE ${table} a SET a.${spec.path}=${spec.clear} ` +
          `WHERE a.id=${quoteLiteral(safeId)}`,
      };
    },
  },

  'reset-land-record': {
    label: 'Reset land record (clear bhoomi + set status)',
    tableKey: 'APPLICANTS_NEW_LOAN_CASES',
    destructive: true,
    build({ stateGroup, id, status = 'loanRefNoGenerated' }) {
      const safeId = assertSafeValue(id, 'id');
      if (!isKnownStatus(status)) {
        throw new OpsActionError(`"${status}" is not a known appStatus`, 'UNKNOWN_STATUS');
      }
      const { table } = resolveTable(stateGroup, 'APPLICANTS_NEW_LOAN_CASES');
      // The combined form ubi-backend itself uses: clear the files AND move the
      // status back, in one statement so the row is never half-reset.
      return {
        table,
        summary: `Clear docs.assets.bhoomi.files and set appStatus="${status}"`,
        sql:
          `UPDATE ${table} a SET a.appStatus=${quoteLiteral(status)}, ` +
          `a.docs.assets.bhoomi.files=[] WHERE a.id=${quoteLiteral(safeId)}`,
      };
    },
  },

  'delete-applicant': {
    label: 'Delete new-loan-case row',
    tableKey: 'APPLICANTS_NEW_LOAN_CASES',
    destructive: true,
    build({ stateGroup, id }) {
      const safeId = assertSafeValue(id, 'id');
      const { table } = resolveTable(stateGroup, 'APPLICANTS_NEW_LOAN_CASES');
      return {
        table,
        summary: `Delete 1 row from ${table}`,
        sql: `DELETE FROM ${table} WHERE id=${quoteLiteral(safeId)}`,
      };
    },
  },

  'delete-custid': {
    label: 'Delete CUSTID_DETAILS row',
    tableKey: 'CUSTID_DETAILS',
    destructive: true,
    build({ stateGroup, id }) {
      const safeId = assertSafeValue(id, 'id');
      const { table } = resolveTable(stateGroup, 'CUSTID_DETAILS');
      // Keyed on id (the primary key per schemas/custId_details.js), not custId,
      // because custId is not unique in that table.
      return {
        table,
        summary: `Delete 1 row from ${table}`,
        sql: `DELETE FROM ${table} WHERE id=${quoteLiteral(safeId)}`,
      };
    },
  },
};

/** Build a statement for an action, or throw OpsActionError. */
export function buildAction(actionName, params) {
  const action = ACTIONS[actionName];
  if (!action) {
    throw new OpsActionError(`Unknown action: ${actionName}`, 'UNKNOWN_ACTION');
  }
  const built = action.build(params || {});
  return {
    action: actionName,
    label: action.label,
    destructive: action.destructive,
    tableKey: action.tableKey,
    needsPath: Boolean(action.needsPath),
    ...built,
  };
}

/** Action descriptors for the UI, without the builders. */
export function listActions() {
  return Object.entries(ACTIONS).map(([name, a]) => ({
    action: name,
    label: a.label,
    tableKey: a.tableKey,
    destructive: a.destructive,
    needsPath: Boolean(a.needsPath),
  }));
}
