#!/usr/bin/env node
/**
 * migrate-target.js — one-time conversion of a live directory into a symlink.
 *
 * Today `ubi-dist` is a real directory. The deployer needs it to be a symlink so
 * a release can be swapped in atomically. This script does that once per target:
 *
 *   1. mv <liveLink> -> <releasesDir>/legacy-<YYYYMMDD>/
 *   2. symlink <liveLink> -> that legacy release
 *   3. pm2 restart <name>, then verify the site still serves and pm2 still
 *      reports the expected serve path
 *
 * Idempotent: if liveLink is already a symlink it reports and exits 0.
 * Requires --confirm, because step 1 moves the directory that is currently
 * serving traffic.
 *
 * Usage:
 *   node scripts/migrate-target.js                      # show status of all targets
 *   node scripts/migrate-target.js <target-key> --confirm
 *   node scripts/migrate-target.js <target-key> --confirm --skip-restart
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const targets = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'deploy-targets.json'), 'utf8')
);

const args = process.argv.slice(2);
const targetKey = args.find((a) => !a.startsWith('--'));
const confirmed = args.includes('--confirm');
const skipRestart = args.includes('--skip-restart');

const log = (msg) => console.log(msg);
const fail = (msg) => {
  console.error(`\n  ERROR  ${msg}\n`);
  process.exit(1);
};

function run(cmd, cmdArgs) {
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { timeout: 60000, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || (err ? err.message : '') });
    });
  });
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

async function describe(key, target) {
  let kind = 'missing';
  let pointsTo = null;
  try {
    const st = await fsp.lstat(target.liveLink);
    if (st.isSymbolicLink()) {
      kind = 'symlink';
      pointsTo = await fsp.readlink(target.liveLink);
    } else if (st.isDirectory()) {
      kind = 'directory';
    } else {
      kind = 'other';
    }
  } catch {
    kind = 'missing';
  }
  return { key, target, kind, pointsTo };
}

/** Report the legacy clutter that could be cleaned up — never delete it. */
async function reportCleanupCandidates(target) {
  const parent = path.dirname(target.liveLink);
  const base = path.basename(target.liveLink);
  let entries;
  try {
    entries = await fsp.readdir(parent, { withFileTypes: true });
  } catch {
    return;
  }

  const candidates = [];
  for (const entry of entries) {
    const name = entry.name;
    if (name === base) continue;
    const isBackup = name.startsWith(`${base}.bak`) || name === 'newfileunzipped';
    const isLooseZip = entry.isFile() && name.toLowerCase().endsWith('.zip');
    if (isBackup || isLooseZip) {
      let size = null;
      try {
        const st = await fsp.stat(path.join(parent, name));
        size = st.size;
      } catch {
        /* ignore */
      }
      candidates.push({ name, size, kind: isLooseZip ? 'zip' : 'backup' });
    }
  }

  if (!candidates.length) return;

  const totalMb =
    candidates.reduce((n, c) => n + (c.size || 0), 0) / 1024 / 1024;

  log('');
  log(`  Cleanup candidates in ${parent} (NOT removed — review by hand):`);
  for (const c of candidates.slice(0, 40)) {
    const sz = c.size == null ? '' : ` (${(c.size / 1024 / 1024).toFixed(1)} MB)`;
    log(`    ${c.kind === 'zip' ? 'zip    ' : 'backup '} ${c.name}${sz}`);
  }
  if (candidates.length > 40) log(`    … and ${candidates.length - 40} more`);
  log(`  ${candidates.length} item(s), ~${totalMb.toFixed(0)} MB total.`);
}

async function showStatus() {
  log('\n  Deploy target status\n');
  for (const [key, target] of Object.entries(targets)) {
    const info = await describe(key, target);
    const state =
      info.kind === 'symlink'
        ? `symlink -> ${info.pointsTo}`
        : info.kind === 'directory'
          ? 'REAL DIRECTORY (needs migration)'
          : info.kind;
    log(`  ${key}`);
    log(`    label      ${target.label}`);
    log(`    liveLink   ${target.liveLink}`);
    log(`    state      ${state}`);
    log(`    releases   ${target.releasesDir}`);
    log('');
  }
  log('  To migrate:  node scripts/migrate-target.js <target-key> --confirm\n');
}

async function migrate(key) {
  const target = targets[key];
  if (!target) {
    fail(`Unknown target "${key}". Valid keys: ${Object.keys(targets).join(', ')}`);
  }

  log(`\n  Migrating ${key} — ${target.label}\n`);

  const info = await describe(key, target);

  if (info.kind === 'symlink') {
    log(`  Already a symlink -> ${info.pointsTo}`);
    log('  Nothing to do (this script is idempotent).\n');
    await reportCleanupCandidates(target);
    return;
  }

  if (info.kind === 'missing') {
    fail(
      `${target.liveLink} does not exist. Expected the live build directory to be there. ` +
        'Stopping rather than inventing one.'
    );
  }

  if (info.kind !== 'directory') {
    fail(`${target.liveLink} is neither a directory nor a symlink — refusing to touch it.`);
  }

  // Sanity-check that this really is a built frontend before moving it.
  const indexPath = path.join(target.liveLink, 'index.html');
  if (!fs.existsSync(indexPath)) {
    fail(
      `${indexPath} not found. ${target.liveLink} does not look like an Angular dist; ` +
        'refusing to migrate the wrong directory.'
    );
  }

  if (!confirmed) {
    log('  DRY RUN — pass --confirm to perform these steps:\n');
    log(`    1. mv ${target.liveLink}`);
    log(`         -> ${path.join(target.releasesDir, `legacy-${stamp()}`)}`);
    log(`    2. ln -s <that release> ${target.liveLink}`);
    log(`    3. ${target.restartCommand.join(' ')}`);
    log(`    4. verify ${target.healthUrl} and pm2 serve path\n`);
    await reportCleanupCandidates(target);
    return;
  }

  /* ---- 1. move the live directory into releases/legacy-<date> ---- */
  await fsp.mkdir(target.releasesDir, { recursive: true });

  let legacyName = `legacy-${stamp()}`;
  let legacyDir = path.join(target.releasesDir, legacyName);
  let suffix = 1;
  while (fs.existsSync(legacyDir)) {
    legacyName = `legacy-${stamp()}-${String(suffix).padStart(6, '0')}`;
    legacyDir = path.join(target.releasesDir, legacyName);
    suffix += 1;
    if (suffix > 50) fail('Cannot allocate a legacy release name');
  }

  log(`  1/4  mv ${target.liveLink} -> ${legacyDir}`);
  try {
    await fsp.rename(target.liveLink, legacyDir);
  } catch (err) {
    if (err.code === 'EXDEV') {
      fail(
        `${target.liveLink} and ${target.releasesDir} are on different filesystems, so the ` +
          'move would not be atomic. Move it by hand during a maintenance window.'
      );
    }
    fail(`Move failed: ${err.message}`);
  }

  // Record provenance so this legacy release looks like any other in the UI.
  const meta = {
    releaseId: legacyName,
    target: key,
    artifact: null,
    username: process.env.USER || process.env.LOGNAME || 'migration',
    deployedAt: new Date().toISOString(),
    mainBundle: null,
    note: 'Adopted from the pre-existing ubi-dist directory by migrate-target.js',
  };
  try {
    const names = await fsp.readdir(legacyDir);
    const main = names.find((n) => /^main[.-][A-Za-z0-9]+\.js$/.test(n));
    if (main) meta.mainBundle = main;
  } catch {
    /* ignore */
  }
  await fsp.writeFile(
    path.join(legacyDir, 'meta.json'),
    `${JSON.stringify(meta, null, 2)}\n`,
    'utf8'
  );

  /* ---- 2. symlink liveLink -> legacy release ---- */
  log(`  2/4  ln -s ${legacyDir} ${target.liveLink}`);
  try {
    await fsp.symlink(legacyDir, target.liveLink);
  } catch (err) {
    // Put it back rather than leaving the site with no directory at all.
    log('       symlink failed — restoring the original directory');
    try {
      await fsp.rename(legacyDir, target.liveLink);
      log('       restored.');
    } catch (restoreErr) {
      console.error(
        `\n  CRITICAL: could not restore ${target.liveLink}. The build is at ` +
          `${legacyDir}. Move it back by hand.\n  (${restoreErr.message})\n`
      );
    }
    fail(`Symlink failed: ${err.message}`);
  }

  /* ---- 3. restart ---- */
  if (skipRestart) {
    log('  3/4  skipped (--skip-restart)');
  } else {
    log(`  3/4  ${target.restartCommand.join(' ')}`);
    const [cmd, ...cmdArgs] = target.restartCommand;
    const restart = await run(cmd, cmdArgs);
    if (restart.stdout.trim()) log(`       ${restart.stdout.trim().split('\n').join('\n       ')}`);
    if (!restart.ok) {
      log(`       restart FAILED: ${restart.stderr.trim()}`);
      log('       The symlink is in place; restart by hand and re-verify.');
    }
  }

  /* ---- 4. verify ---- */
  log('  4/4  verifying');

  let served = false;
  for (let attempt = 0; attempt < 6 && !served; attempt += 1) {
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    try {
      const res = await fetch(target.healthUrl, { headers: { 'cache-control': 'no-cache' } });
      const body = await res.text();
      if (res.ok && /<html|<app-root|<!doctype html/i.test(body)) {
        served = true;
        log(`       ${target.healthUrl} serves HTML (HTTP ${res.status})`);
      } else {
        log(`       attempt ${attempt + 1}: HTTP ${res.status}`);
      }
    } catch (err) {
      log(`       attempt ${attempt + 1}: ${err.message}`);
    }
  }

  const pm2Name = target.pm2Name || target.restartCommand[target.restartCommand.length - 1];
  const describeOut = await run('pm2', ['describe', pm2Name]);
  if (describeOut.ok) {
    const interesting = describeOut.stdout
      .split('\n')
      .filter((l) => /exec cwd|script path|status|PM2_SERVE_PATH|PM2_SERVE_SPA|pm2 env/i.test(l));
    if (interesting.length) {
      log('       pm2 describe:');
      for (const line of interesting) log(`         ${line.trim()}`);
    }
    log(
      `       reminder: confirm PM2_SERVE_SPA is still true with \`pm2 env ${pm2Name}\` ` +
        '— restart preserves it, re-registering would not.'
    );
  } else {
    log(`       pm2 describe ${pm2Name} failed: ${describeOut.stderr.trim()}`);
  }

  log('');
  if (served) {
    log(`  DONE. ${key} is now symlink-based. Release: ${legacyName}`);
  } else {
    log(
      `  WARNING: ${target.healthUrl} did not serve HTML. The symlink is in place at\n` +
        `  ${target.liveLink} -> ${legacyDir}\n` +
        '  Check `pm2 logs` before deploying anything through the tool.'
    );
  }

  await reportCleanupCandidates(target);
  log('');
}

if (!targetKey) {
  await showStatus();
} else {
  await migrate(targetKey);
}
