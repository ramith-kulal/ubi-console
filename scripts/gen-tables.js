#!/usr/bin/env node
/**
 * gen-tables.js — build data/tables.json (the Query Console's table browser
 * reference list) from ubi-backend's src/database/tables.json.
 *
 * This is a READ-ONLY consumer of the ubi-backend repo. Nothing is written back
 * there. The list is generated rather than hand-typed so it cannot drift.
 *
 * Grouping is FAITHFUL to DATA_TABLES: each state block stays its own group.
 * We deliberately do NOT reproduce the merge in ubi-backend's
 * generalutils/utils.js, which spreads the GENERAL block LAST and therefore
 * silently overrides state-suffixed names whose key exists in both. Flattening
 * here would hide which physical table a name actually resolves to per state —
 * exactly the ambiguity an ops console must not introduce.
 *
 * Usage:
 *   node scripts/gen-tables.js [--source <path-to-ubi-backend-tables.json>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_SOURCE =
  '/Users/ramith/Desktop/whatsloan/ubi-backend/src/database/tables.json';

// Keys inside a group that are metadata about the state, not tables.
const META_KEYS = new Set(['STATE', 'STATE_CODE', 'STATES_DIFFERENCES']);

function parseArgs(argv) {
  const out = { source: DEFAULT_SOURCE };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--source') {
      out.source = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

/**
 * A table name containing a dot is a nested (child) table in Oracle NoSQL,
 * e.g. `APPLICANT.LOANDATAS` or `ZONES.ROS.BRANCHES`. Those cannot be queried
 * with a plain JOIN — they need NESTED TABLES (... descendants/ancestors ...).
 * We surface that in the UI so nobody reaches for a JOIN that does not exist.
 */
function describeName(tableName) {
  const segments = tableName.split('.');
  if (segments.length === 1) {
    return { nested: false, parent: null, depth: 0 };
  }
  return {
    nested: true,
    parent: segments.slice(0, -1).join('.'),
    depth: segments.length - 1,
  };
}

function collect(groupName, group) {
  const tables = [];
  const meta = {};
  const seen = new Set();

  const push = (tableName, entryKey, kind, alias) => {
    if (typeof tableName !== 'string' || tableName.trim() === '') return;
    const name = tableName.trim();
    // Same physical table can be referenced by more than one config key.
    const dedupeKey = `${name}::${kind}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    tables.push({
      name,
      key: entryKey,
      alias: alias || null,
      kind, // 'table' | 'backup'
      ...describeName(name),
    });
  };

  for (const entryKey of Object.keys(group)) {
    const value = group[entryKey];

    if (META_KEYS.has(entryKey)) {
      meta[entryKey] = value;
      continue;
    }

    if (typeof value === 'string') {
      // Bare string values in a group are table names in a couple of places.
      push(value, entryKey, 'table', null);
      continue;
    }

    if (Array.isArray(value)) {
      // e.g. DAILY_MIS_SUMMARY.FRESH = ["MIS_SUMMARY_MP", "MIS_SUMMARY_KA"]
      value.forEach((v) => push(v, entryKey, 'table', null));
      continue;
    }

    if (value && typeof value === 'object') {
      // Canonical shape: { TABLENAME, ALIAS } (+ optional BK_TABLENAME).
      push(value.TABLENAME, entryKey, 'table', value.ALIAS);
      push(value.BK_TABLENAME, entryKey, 'backup', value.ALIAS);
    }
    // Empty objects (e.g. MPLRS_API_LOGS: {}) contribute nothing — correct.
  }

  tables.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'table' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { group: groupName, meta, tables };
}

function main() {
  const { source } = parseArgs(process.argv);

  if (!fs.existsSync(source)) {
    console.error(`[gen-tables] source not found: ${source}`);
    console.error('[gen-tables] pass --source <path> if ubi-backend lives elsewhere');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(source, 'utf8'));
  const dataTables = raw.DATA_TABLES;
  if (!dataTables || typeof dataTables !== 'object') {
    console.error('[gen-tables] source has no DATA_TABLES object — aborting');
    process.exit(1);
  }

  const groups = Object.keys(dataTables).map((g) => collect(g, dataTables[g]));

  // Report names that exist in GENERAL *and* in a state group. These are the
  // keys the ubi-backend merge would silently resolve to the GENERAL table.
  const generalGroup = groups.find((g) => g.group === 'GENERAL');
  const generalKeys = new Set(
    generalGroup ? generalGroup.tables.map((t) => t.key) : []
  );
  const shadowed = [];
  for (const g of groups) {
    if (g.group === 'GENERAL') continue;
    for (const t of g.tables) {
      if (generalKeys.has(t.key)) shadowed.push({ group: g.group, key: t.key, name: t.name });
    }
  }

  const totalTables = groups.reduce((n, g) => n + g.tables.length, 0);

  const output = {
    generatedBy: 'scripts/gen-tables.js',
    source,
    note:
      'Grouped faithfully by DATA_TABLES block. GENERAL is spread last in ' +
      "ubi-backend's generalutils/utils.js and overrides state-suffixed keys; " +
      'this file does not flatten, so per-state names stay unambiguous.',
    groupOrder: groups.map((g) => g.group),
    shadowedByGeneral: shadowed,
    groups,
  };

  const outPath = path.join(__dirname, '..', 'data', 'tables.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log(`[gen-tables] wrote ${outPath}`);
  console.log(`[gen-tables] ${groups.length} groups, ${totalTables} table refs`);
  if (shadowed.length) {
    console.log(
      `[gen-tables] ${shadowed.length} state keys are shadowed by GENERAL in ubi-backend's merge:`
    );
    for (const s of shadowed.slice(0, 10)) {
      console.log(`             ${s.group}.${s.key} -> ${s.name}`);
    }
    if (shadowed.length > 10) console.log(`             ... and ${shadowed.length - 10} more`);
  }
}

main();
