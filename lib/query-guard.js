/**
 * query-guard.js — statement analysis for the Query Console.
 *
 * Pure string analysis, no Node dependencies, so the same module runs
 * server-side (where it is authoritative) and in the editor (where it drives the
 * live statement badge). The client copy is a convenience; the server ALWAYS
 * re-analyses and never trusts a client verdict.
 *
 * POLICY: all statement types are permitted, including DDL. That is a deliberate
 * decision by the tool's owner, overriding the original spec's SELECT/UPDATE/
 * DELETE whitelist. What this module still does is make the blast radius
 * visible before anything runs:
 *
 *   SELECT              capped at 500 rows unless you set your own LIMIT
 *   INSERT / UPSERT     confirm step; no preview is possible (nothing exists yet)
 *   UPDATE / DELETE     WHERE is mandatory; the exact affected rows are previewed
 *   DDL (DROP, etc.)    confirm step requiring the object name to be typed,
 *                       because no preview can exist and nothing is reversible
 *
 * The WHERE requirement on UPDATE/DELETE is kept: a preview of affected rows is
 * genuinely achievable there, so refusing to run without one costs nothing and
 * catches the single most common ops mistake.
 */

export const DEFAULT_ROW_LIMIT = 500;
/** One more than the cap, so the caller can report "500+" honestly. */
export const PREVIEW_LIMIT = 501;

/**
 * Which driver call a statement must go through.
 *
 * This is not cosmetic: Oracle NoSQL routes DML through query(), table shape
 * changes through tableDDL(), and security/namespace statements through
 * adminDDL(). Sending `DROP TABLE` to query() simply fails, so the guard has to
 * classify correctly for execution to work at all.
 */
export const CHANNEL_QUERY = 'query';
export const CHANNEL_TABLE_DDL = 'tableDDL';
export const CHANNEL_ADMIN_DDL = 'adminDDL';

/** Risk tiers drive the confirmation the UI demands. */
export const RISK_READ = 'read';
export const RISK_WRITE = 'write';
export const RISK_DESTRUCTIVE = 'destructive';

/** Keywords that terminate a WHERE clause at the top level. */
const CLAUSE_TERMINATORS = ['RETURNING', 'LIMIT', 'OFFSET', 'ORDER', 'GROUP'];

const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_$]*';
/** Table names may be nested: APPLICANT.LOANDATAS, ZONES.ROS.BRANCHES. */
const TABLE_NAME_RE = new RegExp(`^${IDENTIFIER}(?:\\.${IDENTIFIER})*`);

/** Second words that mean the statement is an admin/security operation. */
const ADMIN_OBJECTS = new Set(['NAMESPACE', 'USER', 'ROLE', 'REGION']);

export class QueryRejected extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'QueryRejected';
    this.code = code || 'REJECTED';
  }
}

/* ------------------------------------------------------------------ scanning */

/**
 * Single pass over the text, tracking string and paren state.
 *
 * `masked` is the same length as the input with the *contents* of string
 * literals replaced by spaces. Keyword searches run against it, so a value like
 * 'DELETE FROM x' inside quotes can never be read as syntax.
 *
 * Oracle NoSQL accepts both '...' and "..." for string values (ubi-backend's
 * generated SQL uses double quotes), so both open a quoted region here. Doubled
 * delimiters ('' or "") are the in-string escape.
 */
function scan(sql) {
  const masked = new Array(sql.length);
  const depth = new Array(sql.length).fill(0);
  const comments = [];
  const statementBreaks = [];

  let i = 0;
  let parens = 0;
  let unterminatedString = null;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      masked[i] = ch;
      depth[i] = parens;
      i += 1;

      let closed = false;
      while (i < sql.length) {
        if (sql[i] === '\\' && i + 1 < sql.length) {
          masked[i] = ' ';
          masked[i + 1] = ' ';
          depth[i] = parens;
          depth[i + 1] = parens;
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            masked[i] = ' ';
            masked[i + 1] = ' ';
            depth[i] = parens;
            depth[i + 1] = parens;
            i += 2;
            continue;
          }
          masked[i] = quote;
          depth[i] = parens;
          i += 1;
          closed = true;
          break;
        }
        masked[i] = ' ';
        depth[i] = parens;
        i += 1;
      }

      if (!closed) unterminatedString = start;
      continue;
    }

    if (ch === '-' && sql[i + 1] === '-') {
      comments.push({ index: i, kind: 'line' });
      while (i < sql.length && sql[i] !== '\n') {
        masked[i] = ' ';
        depth[i] = parens;
        i += 1;
      }
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      comments.push({ index: i, kind: 'block' });
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      while (i < stop) {
        masked[i] = ' ';
        depth[i] = parens;
        i += 1;
      }
      continue;
    }

    if (ch === '(') parens += 1;

    masked[i] = ch;
    depth[i] = parens;

    if (ch === ')') parens = Math.max(0, parens - 1);
    if (ch === ';' && parens === 0) statementBreaks.push(i);

    i += 1;
  }

  return {
    masked: masked.join(''),
    depth,
    comments,
    statementBreaks,
    unterminatedString,
    unbalancedParens: parens !== 0,
  };
}

/** Find a bare keyword at paren depth 0 in the masked text. Returns index or -1. */
function findKeyword(masked, depth, keyword, fromIndex = 0) {
  const re = new RegExp(`\\b${keyword}\\b`, 'gi');
  re.lastIndex = fromIndex;
  let match = re.exec(masked);
  while (match) {
    if (depth[match.index] === 0) return match.index;
    match = re.exec(masked);
  }
  return -1;
}

/** All top-level occurrences of a keyword. */
function findAllKeywords(masked, depth, keyword) {
  const out = [];
  const re = new RegExp(`\\b${keyword}\\b`, 'gi');
  let match = re.exec(masked);
  while (match) {
    if (depth[match.index] === 0) out.push(match.index);
    match = re.exec(masked);
  }
  return out;
}

/** Parse `<table> [AS] [alias]`. Returns { table, alias, endIndex } or null. */
function parseTableAndAlias(masked, pos, stopKeywords) {
  let i = pos;
  while (i < masked.length && /\s/.test(masked[i])) i += 1;

  const nameMatch = masked.slice(i).match(TABLE_NAME_RE);
  if (!nameMatch) return null;

  const table = nameMatch[0];
  if (stopKeywords.has(table.toUpperCase())) return null;
  i += table.length;

  while (i < masked.length && /\s/.test(masked[i])) i += 1;

  let alias = null;
  const asMatch = masked.slice(i).match(/^AS\b/i);
  if (asMatch) {
    i += asMatch[0].length;
    while (i < masked.length && /\s/.test(masked[i])) i += 1;
    const aliasMatch = masked.slice(i).match(new RegExp(`^${IDENTIFIER}`));
    // `AS` with nothing usable after it is malformed, not an implicit alias.
    if (!aliasMatch || stopKeywords.has(aliasMatch[0].toUpperCase())) return null;
    alias = aliasMatch[0];
    i += alias.length;
  } else {
    const aliasMatch = masked.slice(i).match(new RegExp(`^${IDENTIFIER}`));
    if (aliasMatch && !stopKeywords.has(aliasMatch[0].toUpperCase())) {
      alias = aliasMatch[0];
      i += alias.length;
    }
  }

  return { table, alias, endIndex: i };
}

/** WHERE clause text, ending at a top-level terminator. Slices the ORIGINAL sql. */
function extractWhere(sql, masked, depth, whereIndex) {
  const start = whereIndex + 'WHERE'.length;

  let end = sql.length;
  for (const terminator of CLAUSE_TERMINATORS) {
    const at = findKeyword(masked, depth, terminator, start);
    if (at !== -1 && at < end) end = at;
  }

  return sql.slice(start, end).trim();
}

/* --------------------------------------------------------------- classifying */

/** Words 1 and 2, uppercased, from the masked text. */
function leadingWords(masked) {
  const words = masked.trim().split(/\s+/).slice(0, 3);
  return words.map((w) => w.replace(/[^A-Za-z_]/g, '').toUpperCase());
}

/**
 * Decide statement type, driver channel and risk tier.
 * Unknown leading keywords are passed to query() rather than refused — the
 * database is then the authority on whether the dialect supports them.
 */
function classify(masked) {
  const [first, second] = leadingWords(masked);

  switch (first) {
    case 'SELECT':
      return { type: 'SELECT', channel: CHANNEL_QUERY, risk: RISK_READ };
    case 'INSERT':
    case 'UPSERT':
      return { type: first, channel: CHANNEL_QUERY, risk: RISK_WRITE };
    case 'UPDATE':
    case 'DELETE':
      return { type: first, channel: CHANNEL_QUERY, risk: RISK_WRITE };

    case 'CREATE':
    case 'DROP':
    case 'ALTER': {
      if (ADMIN_OBJECTS.has(second)) {
        return { type: `${first} ${second}`, channel: CHANNEL_ADMIN_DDL, risk: RISK_DESTRUCTIVE };
      }
      const type = second ? `${first} ${second}` : first;
      return { type, channel: CHANNEL_TABLE_DDL, risk: RISK_DESTRUCTIVE };
    }

    case 'TRUNCATE':
      return { type: 'TRUNCATE', channel: CHANNEL_TABLE_DDL, risk: RISK_DESTRUCTIVE };

    case 'GRANT':
    case 'REVOKE':
      return { type: first, channel: CHANNEL_ADMIN_DDL, risk: RISK_DESTRUCTIVE };

    case 'DESCRIBE':
    case 'DESC':
    case 'SHOW':
      return { type: first, channel: CHANNEL_ADMIN_DDL, risk: RISK_READ };

    default:
      return { type: first || 'UNKNOWN', channel: CHANNEL_QUERY, risk: RISK_WRITE };
  }
}

/**
 * Best-effort object name for a DDL statement, used for the typed
 * confirmation. Returns null when it cannot be read — the UI then asks the user
 * to type the statement keyword instead of guessing a name.
 */
function extractDdlObject(masked) {
  const patterns = [
    /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$.]*)/i,
    /^\s*TRUNCATE\s+(?:TABLE\s+)?([A-Za-z_][A-Za-z0-9_$.]*)/i,
    /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$.]*)/i,
    /^\s*ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_$.]*)/i,
    /^\s*DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?[A-Za-z_][A-Za-z0-9_$]*\s+ON\s+([A-Za-z_][A-Za-z0-9_$.]*)/i,
    /^\s*CREATE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[A-Za-z_][A-Za-z0-9_$]*\s+ON\s+([A-Za-z_][A-Za-z0-9_$.]*)/i,
    /^\s*DROP\s+(?:NAMESPACE|USER|ROLE)\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$.]*)/i,
    /^\s*CREATE\s+(?:NAMESPACE|USER|ROLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$.]*)/i,
  ];
  for (const re of patterns) {
    const m = masked.match(re);
    if (m) return m[1];
  }
  return null;
}

/* ------------------------------------------------------------------ analysis */

function reject(reason, code, extra = {}) {
  return {
    ok: false,
    blocked: true,
    reason,
    code,
    requiresConfirmation: false,
    requiresTypedConfirmation: false,
    ...extra,
  };
}

/**
 * Analyse a query. Never throws — returns a verdict so the editor can render the
 * reason inline as the user types.
 */
export function analyzeQuery(input) {
  const raw = typeof input === 'string' ? input : '';
  const trimmed = raw.trim();

  if (!trimmed) return reject('Empty query', 'EMPTY', { type: null });

  let scanned = scan(trimmed);

  if (scanned.unterminatedString !== null) {
    return reject('Unterminated string literal — check your quotes', 'UNTERMINATED_STRING', {
      type: null,
    });
  }

  // Comments are refused even though statements are not.
  //
  // An apostrophe inside `/* it's fine */` desynchronises quote tracking, so the
  // preview could describe different rows than the statement actually touches.
  // Refusing comments removes that class of bug entirely, and no ops query needs
  // them.
  if (scanned.comments.length > 0) {
    return reject(
      'SQL comments are not allowed here (-- or /* */). They can hide text and break ' +
        'the guarantee that the preview matches what executes.',
      'COMMENT_NOT_ALLOWED',
      { type: null }
    );
  }

  // Strip a single trailing semicolon; refuse anything after it.
  let normalized = trimmed;
  if (scanned.statementBreaks.length > 0) {
    const last = scanned.statementBreaks[scanned.statementBreaks.length - 1];
    const tail = trimmed.slice(last + 1).trim();
    if (tail === '' && scanned.statementBreaks.length === 1) {
      normalized = trimmed.slice(0, last).trim();
      scanned = scan(normalized);
    } else {
      // One statement per run: two statements share one confirmation, which
      // would mean confirming a preview of the first while the second also runs.
      return reject('Only one statement may be run at a time', 'MULTIPLE_STATEMENTS', {
        type: null,
      });
    }
  }

  if (!normalized) return reject('Empty query', 'EMPTY', { type: null });
  if (scanned.unbalancedParens) {
    return reject('Unbalanced parentheses', 'UNBALANCED_PARENS', { type: null });
  }

  const { masked, depth } = scanned;
  const { type, channel, risk } = classify(masked);

  if (type === 'SELECT') return analyzeSelect(normalized, masked, depth, channel);
  if (type === 'UPDATE' || type === 'DELETE') {
    return analyzeMutation(type, normalized, masked, depth, channel);
  }
  if (type === 'INSERT' || type === 'UPSERT') {
    return analyzeInsert(type, normalized, masked, depth, channel);
  }
  if (risk === RISK_DESTRUCTIVE) {
    return analyzeDdl(type, normalized, masked, channel);
  }

  // DESCRIBE / SHOW / anything else — let the database judge the syntax.
  return {
    ok: true,
    blocked: false,
    type,
    channel,
    risk,
    normalized,
    requiresConfirmation: risk !== RISK_READ,
    requiresTypedConfirmation: false,
    executable: normalized,
  };
}

function analyzeSelect(sql, masked, depth, channel) {
  const hasTopLevelLimit = findKeyword(masked, depth, 'LIMIT') !== -1;

  return {
    ok: true,
    blocked: false,
    type: 'SELECT',
    channel,
    risk: RISK_READ,
    normalized: sql,
    requiresConfirmation: false,
    requiresTypedConfirmation: false,
    // An unlimited SELECT on APPLICANT would stream the whole table into a
    // browser tab. Cap it, and tell the user what the cap is.
    limitApplied: !hasTopLevelLimit,
    effectiveLimit: hasTopLevelLimit ? null : DEFAULT_ROW_LIMIT,
    executable: hasTopLevelLimit ? sql : `${sql} LIMIT ${DEFAULT_ROW_LIMIT}`,
  };
}

function analyzeInsert(type, sql, masked, depth, channel) {
  // INSERT INTO <table> ... — the table is informational here; there is nothing
  // to preview because the rows do not exist yet.
  const intoIndex = findKeyword(masked, depth, 'INTO');
  let table = null;
  if (intoIndex !== -1) {
    const parsed = parseTableAndAlias(masked, intoIndex + 'INTO'.length, new Set(['VALUES']));
    if (parsed) table = parsed.table;
  }

  return {
    ok: true,
    blocked: false,
    type,
    channel,
    risk: RISK_WRITE,
    normalized: sql,
    table,
    requiresConfirmation: true,
    requiresTypedConfirmation: false,
    previewSql: null,
    previewNote: 'No preview is possible for an insert — the rows do not exist yet.',
    executable: sql,
  };
}

function analyzeMutation(type, sql, masked, depth, channel) {
  const stopKeywords = new Set([
    'WHERE',
    'SET',
    'RETURNING',
    'LIMIT',
    'OFFSET',
    'ORDER',
    'GROUP',
  ]);

  let tableStart;
  if (type === 'DELETE') {
    const fromIndex = findKeyword(masked, depth, 'FROM');
    if (fromIndex === -1) {
      return reject('DELETE must be of the form DELETE FROM <table> WHERE …', 'NO_FROM', { type });
    }
    tableStart = fromIndex + 'FROM'.length;
  } else {
    tableStart = 'UPDATE'.length;
  }

  const parsed = parseTableAndAlias(masked, tableStart, stopKeywords);
  if (!parsed) {
    return reject(
      'Cannot safely preview this query: the target table could not be identified.',
      'CANNOT_PARSE_TABLE',
      { type }
    );
  }

  if (type === 'UPDATE' && findKeyword(masked, depth, 'SET', parsed.endIndex) === -1) {
    return reject('UPDATE must include a SET clause', 'NO_SET', { type });
  }

  const whereOccurrences = findAllKeywords(masked, depth, 'WHERE');

  if (whereOccurrences.length === 0) {
    // Kept as a hard reject even under the permissive policy: unlike DDL, a
    // row-level preview here is achievable, so there is no reason to run blind.
    return reject(
      `${type} without a WHERE clause would affect every row in ${parsed.table}. ` +
        'Add a WHERE clause — or use a DDL statement if you really mean to empty the table.',
      'NO_WHERE',
      { type, table: parsed.table }
    );
  }

  if (whereOccurrences.length > 1) {
    return reject(
      'Cannot safely preview this query: more than one top-level WHERE found.',
      'AMBIGUOUS_WHERE',
      { type, table: parsed.table }
    );
  }

  const where = extractWhere(sql, masked, depth, whereOccurrences[0]);
  if (!where) {
    return reject(
      'Cannot safely preview this query: the WHERE clause is empty.',
      'EMPTY_WHERE',
      { type, table: parsed.table }
    );
  }

  const aliasPart = parsed.alias ? ` ${parsed.alias}` : '';

  return {
    ok: true,
    blocked: false,
    type,
    channel,
    risk: RISK_WRITE,
    normalized: sql,
    requiresConfirmation: true,
    requiresTypedConfirmation: false,
    table: parsed.table,
    alias: parsed.alias,
    where,
    // 501 so the caller can honestly say "500+" instead of implying an exact count.
    previewSql: `SELECT * FROM ${parsed.table}${aliasPart} WHERE ${where} LIMIT ${PREVIEW_LIMIT}`,
    executable: sql,
  };
}

function analyzeDdl(type, sql, masked, channel) {
  const object = extractDdlObject(masked);

  return {
    ok: true,
    blocked: false,
    type,
    channel,
    risk: RISK_DESTRUCTIVE,
    normalized: sql,
    table: object,
    requiresConfirmation: true,
    // No preview can exist for a schema change and nothing is reversible, so the
    // confirmation is deliberately harder: the object name must be typed out.
    requiresTypedConfirmation: true,
    typedConfirmationValue: object || type,
    previewSql: null,
    previewNote:
      `${type} cannot be previewed and cannot be undone by this tool. ` +
      'There is no backup or restore path here.',
    executable: sql,
  };
}

/**
 * Lightweight classification for the editor badge. Shares analyzeQuery so the
 * badge cannot disagree with the server's decision.
 */
export function statementBadge(sql) {
  if (!sql || !sql.trim()) return { label: '', blocked: false, reason: null };

  const verdict = analyzeQuery(sql);
  if (verdict.blocked) {
    return { label: '⛔ BLOCKED', blocked: true, reason: verdict.reason, code: verdict.code };
  }
  return {
    label: verdict.type,
    blocked: false,
    reason: null,
    risk: verdict.risk,
    channel: verdict.channel,
    requiresConfirmation: verdict.requiresConfirmation,
    requiresTypedConfirmation: verdict.requiresTypedConfirmation,
    effectiveLimit: verdict.effectiveLimit,
    limitApplied: verdict.limitApplied,
    table: verdict.table,
  };
}
