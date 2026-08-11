#!/usr/bin/env node
/**
 * gen-app-statuses.js — build data/app-statuses.json from ubi-backend's
 * config/constants.json (APP_JOURNEY_STATUS + APP_JOURNEY_STATUS_INFO).
 *
 * Generated rather than hand-typed for the same reason as the table list: if a
 * status is added or renamed in the backend, an ops tool offering a stale
 * dropdown would let someone set a value the application no longer understands.
 * Re-run this after a constants.json change.
 *
 * Usage:
 *   node scripts/gen-app-statuses.js [--source <path-to-constants.json>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_SOURCE =
  '/Users/ramith/Desktop/whatsloan/ubi-backend/src/config/constants.json';

/**
 * The dropdown offers exactly APP_JOURNEY_STATUS and nothing else.
 *
 * ubi-backend code also writes `pending` (the column default), `failed` and
 * `failure` in places, but those are not part of the journey enum and were
 * deliberately excluded: an ops tool that offers a status the journey does not
 * define invites setting an applicant to a state the app cannot interpret.
 * Anything outside the enum is still reachable through the Terminal.
 */
const EXTRA_STATUSES = [];

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

function main() {
  const { source } = parseArgs(process.argv);

  if (!fs.existsSync(source)) {
    console.error(`[gen-app-statuses] source not found: ${source}`);
    console.error('[gen-app-statuses] pass --source <path> if ubi-backend lives elsewhere');
    process.exit(1);
  }

  const constants = JSON.parse(fs.readFileSync(source, 'utf8'));
  const enumMap = constants.APP_JOURNEY_STATUS;
  const infoMap = constants.APP_JOURNEY_STATUS_INFO || {};

  if (!enumMap || typeof enumMap !== 'object') {
    console.error('[gen-app-statuses] APP_JOURNEY_STATUS missing from constants.json — aborting');
    process.exit(1);
  }

  const statuses = Object.entries(enumMap).map(([key, value]) => ({
    key,
    value,
    label: infoMap[key] || value,
    source: 'APP_JOURNEY_STATUS',
  }));

  const known = new Set(statuses.map((s) => s.value));
  for (const extra of EXTRA_STATUSES) {
    if (!known.has(extra.value)) statuses.push({ key: null, ...extra });
  }

  const output = {
    generatedBy: 'scripts/gen-app-statuses.js',
    source,
    note:
      'appStatus values for the APPLICANT table. Generated from APP_JOURNEY_STATUS; ' +
      'a few values seen only in ubi-backend code are appended explicitly.',
    statuses,
  };

  const outPath = path.join(__dirname, '..', 'data', 'app-statuses.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log(`[gen-app-statuses] wrote ${outPath}`);
  console.log(`[gen-app-statuses] ${statuses.length} statuses`);
  for (const s of statuses) console.log(`             ${s.value}  —  ${s.label}`);
}

main();
