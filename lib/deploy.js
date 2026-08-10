/**
 * deploy.js — extract, swap, restart, verify, roll back, prune.
 *
 * Design constraints that shaped this file:
 *
 *  - The swap must be atomic. `rm -rf ubi-dist && unzip new.zip` (the current
 *    manual process) has a window of seconds where the site is half-missing.
 *    A symlink written to a temp name and then rename(2)'d over the old one has
 *    no such window.
 *  - `pm2 serve` holds the served directory's inode, so swapping the symlink
 *    changes nothing until the process restarts. The restart is mandatory.
 *  - `pm2 restart <name>` reuses pm2's stored config and preserves
 *    PM2_SERVE_SPA=true. Delete-and-re-add would silently drop --spa and 404
 *    every deep link on refresh, so it is never done here.
 *  - Because SPA mode falls back to index.html for every path, an HTTP 200 from
 *    the health URL proves nothing at all — a stale build answers 200 just as
 *    happily. The check asserts the *new* main.<hash>.js is referenced.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import yauzl from 'yauzl';
import { assertInside } from './targets.js';
import { assertSafeEntryName, findMainBundle } from './zip-inspect.js';

const LOCK_FILENAME = '.deploy.lock';
const LOCK_STALE_MS = 15 * 60 * 1000;
const RESTART_TIMEOUT_MS = 60 * 1000;

/** Health-check retry schedule (ms). pm2 restart latency is ~1-3s in practice. */
const HEALTH_BACKOFF_MS = [500, 1000, 1500, 2500, 4000, 6000, 8000];

class DeployError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DeployError';
    this.code = code || 'DEPLOY_FAILED';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Release id: sortable, human-readable, second-resolution. */
export function releaseId(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/* ------------------------------------------------------------------ locking */

/**
 * Exclusive per-target lock. Two people swapping the same symlink concurrently
 * would interleave extract/restart and leave an indeterminate release live.
 */
export async function acquireLock(target, username) {
  await fsp.mkdir(target.releasesDir, { recursive: true });
  const lockPath = path.join(target.releasesDir, LOCK_FILENAME);

  const payload = JSON.stringify({
    pid: process.pid,
    username,
    target: target.key,
    acquiredAt: new Date().toISOString(),
  });

  try {
    // 'wx' fails if the file exists — that is the mutual exclusion.
    await fsp.writeFile(lockPath, payload, { flag: 'wx' });
    return lockPath;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }

  // Existing lock: take it over only if clearly stale, so a crashed deploy
  // does not block the box forever.
  let existing = null;
  try {
    existing = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
  } catch {
    /* unreadable lock is treated as stale below */
  }

  const age = existing?.acquiredAt ? Date.now() - Date.parse(existing.acquiredAt) : Infinity;
  if (Number.isFinite(age) && age < LOCK_STALE_MS) {
    throw new DeployError(
      `A deploy to ${target.key} is already running (started by ` +
        `${existing.username || 'unknown'} at ${existing.acquiredAt}). ` +
        'Wait for it to finish.',
      'LOCKED'
    );
  }

  await fsp.writeFile(lockPath, payload);
  return lockPath;
}

export async function releaseLock(lockPath) {
  if (!lockPath) return;
  try {
    await fsp.unlink(lockPath);
  } catch {
    /* already gone */
  }
}

/* --------------------------------------------------------------- extraction */

/**
 * Extract `zipPath` into `destDir`, stripping `wrapper` if present.
 *
 * Every entry name is re-validated here even though zip-inspect already
 * validated it. The check is cheap and this is the point where a bad name
 * becomes a write to the filesystem; a future refactor that reorders the
 * callers must not be able to turn that into an escape.
 */
export function extractZip(zipPath, destDir, wrapper, onFile) {
  return new Promise((resolve, reject) => {
    const options = { lazyEntries: true, autoClose: true, decodeStrings: false };
    yauzl.open(zipPath, options, (err, zipfile) => {
      if (err) {
        reject(new DeployError(`Cannot open archive: ${err.message}`, 'EXTRACT_FAILED'));
        return;
      }

      let count = 0;
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        try {
          zipfile.close();
        } catch {
          /* closing */
        }
        reject(e instanceof DeployError ? e : new DeployError(e.message, 'EXTRACT_FAILED'));
      };

      zipfile.on('error', fail);

      zipfile.on('entry', (entry) => {
        (async () => {
          const rawName = Buffer.isBuffer(entry.fileName)
            ? entry.fileName.toString('utf8')
            : entry.fileName;

          // Re-assert safety at the write boundary.
          const safeName = assertSafeEntryName(rawName);

          let relative = safeName;
          if (wrapper) {
            const prefix = `${wrapper}/`;
            if (!relative.startsWith(prefix)) {
              // Outside the wrapper we said we'd strip: skip rather than guess.
              zipfile.readEntry();
              return;
            }
            relative = relative.slice(prefix.length);
          }
          if (!relative) {
            zipfile.readEntry();
            return;
          }

          const outPath = assertInside(destDir, path.join(destDir, relative));

          if (/\/$/.test(safeName)) {
            await fsp.mkdir(outPath, { recursive: true });
            zipfile.readEntry();
            return;
          }

          await fsp.mkdir(path.dirname(outPath), { recursive: true });

          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr) {
              fail(new DeployError(`Read failed for ${relative}: ${streamErr.message}`));
              return;
            }
            const writeStream = fs.createWriteStream(outPath, { mode: 0o644 });
            readStream.on('error', fail);
            writeStream.on('error', fail);
            writeStream.on('finish', () => {
              count += 1;
              if (onFile && count % 50 === 0) onFile(count);
              zipfile.readEntry();
            });
            readStream.pipe(writeStream);
          });
        })().catch(fail);
      });

      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(count);
      });

      zipfile.readEntry();
    });
  });
}

/* --------------------------------------------------------------- the symlink */

/** What the live symlink currently points at, or null. */
export async function currentLiveRelease(target) {
  try {
    const stat = await fsp.lstat(target.liveLink);
    if (!stat.isSymbolicLink()) return null;
    const resolved = await fsp.realpath(target.liveLink);
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Refuse to deploy while liveLink is still a real directory. Renaming a symlink
 * over a populated directory fails (ENOTEMPTY/EISDIR), and forcing it would
 * mean deleting the live site first — exactly the non-atomic window we exist to
 * remove. migrate-target.js converts it once, safely.
 */
export async function assertLiveLinkIsSymlink(target) {
  let stat;
  try {
    stat = await fsp.lstat(target.liveLink);
  } catch (err) {
    if (err.code === 'ENOENT') return; // first deploy; symlink will be created
    throw err;
  }
  if (!stat.isSymbolicLink()) {
    throw new DeployError(
      `${target.liveLink} is a real directory, not a symlink. Run ` +
        `\`node scripts/migrate-target.js ${target.key} --confirm\` once before ` +
        'deploying through this tool.',
      'NOT_MIGRATED'
    );
  }
}

/**
 * Point liveLink at releaseDir atomically: write the new symlink under a temp
 * name in the same directory, then rename(2) it into place. Same-directory
 * rename is atomic, so no reader ever sees a missing or partial target.
 */
export async function atomicSwap(target, releaseDir) {
  const tmpLink = `${target.liveLink}.tmp`;
  try {
    await fsp.unlink(tmpLink);
  } catch {
    /* no leftover */
  }
  await fsp.symlink(releaseDir, tmpLink);
  await fsp.rename(tmpLink, target.liveLink);
}

/* ------------------------------------------------------------------- restart */

/**
 * Run the target's restart command with execFile — argv array, no shell.
 * exec() with an interpolated string would make any future dynamic value a
 * command-injection sink; there is no reason to involve /bin/sh here.
 */
export function runRestart(target) {
  const [cmd, ...args] = target.restartCommand;
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: RESTART_TIMEOUT_MS, encoding: 'utf8', env: process.env },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (err.code ?? 1) : 0,
          stdout: stdout || '',
          stderr: stderr || (err ? err.message : ''),
        });
      }
    );
  });
}

/* -------------------------------------------------------------- health check */

/**
 * Assert the NEW build is being served.
 *
 * PM2_SERVE_SPA=true rewrites every unknown path to index.html, so status 200
 * is not evidence of anything. When we know the new main.<hash>.js we require
 * the served index.html to reference it; without a hashed bundle we can only
 * fall back to "is this an HTML document", and we say so in the log.
 */
export async function healthCheck(target, expectedMainBundle, log) {
  // A target may shorten the schedule (the integration tests do); production
  // targets use the default, which tolerates a slow pm2 restart.
  const backoff = Array.isArray(target.healthBackoffMs)
    ? target.healthBackoffMs
    : HEALTH_BACKOFF_MS;
  const attempts = backoff.length;

  for (let i = 0; i < attempts; i += 1) {
    await sleep(backoff[i]);

    let response;
    let body = '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      response = await fetch(target.healthUrl, {
        signal: controller.signal,
        headers: { 'cache-control': 'no-cache' },
      });
      body = await response.text();
      clearTimeout(timer);
    } catch (err) {
      log(`health: attempt ${i + 1}/${attempts} — request failed (${err.message})`);
      continue;
    }

    if (!response.ok) {
      log(`health: attempt ${i + 1}/${attempts} — HTTP ${response.status}`);
      continue;
    }

    if (expectedMainBundle) {
      const bundleBasename = path.basename(expectedMainBundle);
      if (body.includes(bundleBasename)) {
        log(`health: OK — served index.html references ${bundleBasename}`);
        return { ok: true, asserted: 'bundle' };
      }
      log(
        `health: attempt ${i + 1}/${attempts} — HTTP 200 but ${bundleBasename} ` +
          'not referenced yet (stale build still being served)'
      );
      continue;
    }

    if (/<html|<app-root|<!doctype html/i.test(body)) {
      log(
        'health: OK — HTTP 200 and an HTML document was returned. NOTE: no ' +
          'main.<hash>.js was present in the archive, so this cannot prove the ' +
          'new build is live.'
      );
      return { ok: true, asserted: 'html-only' };
    }

    log(`health: attempt ${i + 1}/${attempts} — HTTP 200 but body is not HTML`);
  }

  return {
    ok: false,
    error: expectedMainBundle
      ? `Health check failed: ${target.healthUrl} never served a page referencing ` +
        `${path.basename(expectedMainBundle)} after ${attempts} attempts.`
      : `Health check failed: ${target.healthUrl} never returned an HTML page after ` +
        `${attempts} attempts.`,
  };
}

/* -------------------------------------------------------------- release list */

const RELEASE_DIR_RE = /^(?:\d{8}-\d{6}(?:-\d+)?|legacy-\d{8}(?:-\d+)?)$/;

/**
 * Ordering key for release ids.
 *
 * A plain string sort is wrong: 'l' > '2', so `legacy-20260810` would sort above
 * `20260810-143000` and the oldest release would appear newest. A `legacy-*`
 * release is by definition the build adopted from the pre-migration directory,
 * so it is always the oldest. Encode that explicitly.
 */
function releaseSortKey(id) {
  return id.startsWith('legacy-') ? `0:${id}` : `1:${id}`;
}

/** All releases for a target, newest first, with LIVE flagged. */
export async function listReleases(target) {
  let dirents;
  try {
    dirents = await fsp.readdir(target.releasesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { releases: [], live: null };
    throw err;
  }

  const live = await currentLiveRelease(target);

  const releases = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    if (!RELEASE_DIR_RE.test(dirent.name)) continue;

    const dir = path.join(target.releasesDir, dirent.name);

    // Compare resolved paths. `live` came from realpath(), so comparing it to an
    // unresolved join breaks the moment any parent component is itself a
    // symlink — and then nothing is ever marked LIVE, which silently disables
    // rollback's already-live check and prune's protection of the live release.
    let resolvedDir = dir;
    try {
      resolvedDir = await fsp.realpath(dir);
    } catch {
      /* keep the unresolved path */
    }

    let meta = {};
    try {
      meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
    } catch {
      meta = {};
    }

    let stat = null;
    try {
      stat = await fsp.stat(dir);
    } catch {
      /* vanished */
    }

    // The retained artifact sits beside the release directory.
    const artifactPath = path.join(target.releasesDir, `${dirent.name}.zip`);
    const hasArtifact = fs.existsSync(artifactPath);

    releases.push({
      id: dirent.name,
      dir,
      isLive: live !== null && resolvedDir === live,
      deployedBy: meta.username || null,
      deployedAt: meta.deployedAt || (stat ? stat.mtime.toISOString() : null),
      artifact: meta.artifact || null,
      mainBundle: meta.mainBundle || null,
      sha256: meta.sha256 || null,
      note: meta.note || null,
      hasArtifact,
      // A release that failed its health check was never successfully served.
      failed: Boolean(meta.failed),
      failureReason: meta.failureReason || null,
    });
  }

  // Newest first.
  releases.sort((a, b) => {
    const ka = releaseSortKey(a.id);
    const kb = releaseSortKey(b.id);
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
  return { releases, live };
}

/**
 * Prune to keepReleases, oldest first. Never removes the live release or the
 * one directly behind it (the rollback target), regardless of count.
 */
export async function pruneReleases(target, log) {
  const { releases } = await listReleases(target);
  const liveIndex = releases.findIndex((r) => r.isLive);
  const protectedIds = new Set();
  if (liveIndex !== -1) {
    protectedIds.add(releases[liveIndex].id);
    if (releases[liveIndex + 1]) protectedIds.add(releases[liveIndex + 1].id);
  }

  const keep = target.keepReleases;
  const removed = [];

  for (let i = keep; i < releases.length; i += 1) {
    const release = releases[i];
    if (protectedIds.has(release.id)) {
      log(`prune: keeping ${release.id} (live or rollback target)`);
      continue;
    }

    const dir = assertInside(target.releasesDir, release.dir);
    await fsp.rm(dir, { recursive: true, force: true });

    const artifact = assertInside(target.releasesDir, `${dir}.zip`);
    try {
      await fsp.unlink(artifact);
    } catch {
      /* no retained artifact */
    }

    removed.push(release.id);
    log(`prune: removed ${release.id}`);
  }

  if (!removed.length) log(`prune: nothing to remove (${releases.length} releases, keep ${keep})`);
  return removed;
}

/* ------------------------------------------------------- swap + verify cycle */

/**
 * Swap to `releaseDir`, restart, health-check, and roll back automatically on
 * failure. Shared by deploy and by manual rollback so both paths get identical
 * verification — a rollback that is not health-checked is a guess.
 */
async function swapRestartVerify({ target, releaseDir, mainBundle, previousDir, log, step }) {
  step('swap', 'running');
  await atomicSwap(target, releaseDir);
  log(`swap: ${target.liveLink} -> ${releaseDir}`);
  step('swap', 'ok');

  step('restart', 'running');
  const restart = await runRestart(target);
  if (restart.stdout.trim()) log(`pm2 stdout: ${restart.stdout.trim()}`);
  if (restart.stderr.trim()) log(`pm2 stderr: ${restart.stderr.trim()}`);
  if (!restart.ok) {
    step('restart', 'failed');
    // No point health-checking a process that did not restart, but we still
    // attempt the rollback so the symlink does not stay pointed at a release
    // nobody has verified.
    if (previousDir) await rollbackTo({ target, previousDir, log, step, reason: 'restart failed' });
    return {
      ok: false,
      error: `pm2 restart failed (exit ${restart.code}). ${restart.stderr.trim()}`,
      rolledBack: Boolean(previousDir),
    };
  }
  log(`restart: ${target.restartCommand.join(' ')} exited 0`);
  step('restart', 'ok');

  step('health', 'running');
  const health = await healthCheck(target, mainBundle, log);
  if (!health.ok) {
    step('health', 'failed');
    log(health.error);
    if (previousDir) {
      await rollbackTo({ target, previousDir, log, step, reason: 'health check failed' });
      return { ok: false, error: health.error, rolledBack: true };
    }
    log('rollback: skipped — there is no previous release to return to');
    return { ok: false, error: health.error, rolledBack: false };
  }
  step('health', 'ok');

  return { ok: true, asserted: health.asserted };
}

/** Re-point the symlink at a previous release and restart. */
async function rollbackTo({ target, previousDir, log, step, reason }) {
  step('rollback', 'running');
  log(`rollback: ${reason} — returning to ${previousDir}`);
  try {
    await atomicSwap(target, previousDir);
    const restart = await runRestart(target);
    if (restart.stdout.trim()) log(`pm2 stdout: ${restart.stdout.trim()}`);
    if (!restart.ok) {
      log(`rollback: pm2 restart FAILED (exit ${restart.code}) — ${restart.stderr.trim()}`);
      step('rollback', 'failed');
      return false;
    }
    log(`rollback: complete, ${target.liveLink} -> ${previousDir}`);
    step('rollback', 'ok');
    return true;
  } catch (err) {
    log(`rollback: FAILED — ${err.message}`);
    step('rollback', 'failed');
    return false;
  }
}

/* ------------------------------------------------------------ public actions */

/**
 * Full deploy. `emit` receives {type:'log'|'step'|'done'|'error', ...} events,
 * which the commit route streams to the browser so the user watches real steps
 * instead of a spinner.
 */
export async function deployRelease({ target, zipPath, plan, username, artifactName, emit }) {
  const log = (message) => emit({ type: 'log', message });
  const step = (name, status) => emit({ type: 'step', name, status });

  let lockPath = null;
  let releaseDir = null;
  let previousDir = null;

  try {
    await assertLiveLinkIsSymlink(target);

    lockPath = await acquireLock(target, username);
    log(`lock: acquired for ${target.key}`);

    previousDir = await currentLiveRelease(target);
    log(previousDir ? `current live release: ${previousDir}` : 'no current release (first deploy)');

    /* ---- extract ---- */
    step('extract', 'running');
    const id = await nextFreeReleaseId(target);
    releaseDir = assertInside(target.releasesDir, path.join(target.releasesDir, id));
    await fsp.mkdir(releaseDir, { recursive: true });

    const fileCount = await extractZip(zipPath, releaseDir, plan.wrapper, (n) =>
      log(`extract: ${n} files...`)
    );
    log(`extract: ${fileCount} files into ${releaseDir}`);
    if (plan.wrapper) log(`extract: stripped wrapper folder "${plan.wrapper}/"`);

    // Some builds ship a custom entry document (e.g. index.ubidev.html) because
    // angular.json points the configuration at one. PM2_SERVE_SPA falls back to
    // `index.html` specifically, so copy it into place — the same `cp` the team
    // does by hand. The original is kept in case anything references it.
    if (plan.indexCopyFrom) {
      const source = assertInside(releaseDir, path.join(releaseDir, plan.indexCopyFrom));
      const destination = assertInside(releaseDir, path.join(releaseDir, 'index.html'));
      if (!fs.existsSync(source)) {
        throw new DeployError(
          `Expected entry document ${plan.indexCopyFrom} is missing after extraction`,
          'EXTRACT_FAILED'
        );
      }
      await fsp.copyFile(source, destination);
      log(`index: copied ${plan.indexCopyFrom} -> index.html (PM2_SERVE_SPA needs that name)`);
    }

    // Confirm the thing we promised is actually on disk.
    const indexOnDisk = path.join(releaseDir, 'index.html');
    if (!fs.existsSync(indexOnDisk)) {
      throw new DeployError(
        'index.html is not present after extraction — refusing to swap',
        'EXTRACT_FAILED'
      );
    }

    const mainBundle = plan.mainBundle || findMainBundle(await listRelative(releaseDir));

    const meta = {
      releaseId: id,
      target: target.key,
      artifact: artifactName,
      username,
      deployedAt: new Date().toISOString(),
      mainBundle,
      sha256: plan.sha256,
      entryCount: fileCount,
      wrapperStripped: plan.wrapper || null,
    };
    await fsp.writeFile(
      path.join(releaseDir, 'meta.json'),
      `${JSON.stringify(meta, null, 2)}\n`,
      'utf8'
    );

    // Retain the artifact beside the release so an exact past build can be
    // redeployed later without hunting through ~30 loose zips.
    const retained = assertInside(target.releasesDir, path.join(target.releasesDir, `${id}.zip`));
    await fsp.copyFile(zipPath, retained);
    log(`artifact: retained as ${path.basename(retained)}`);
    step('extract', 'ok');

    /* ---- swap, restart, verify ---- */
    const result = await swapRestartVerify({
      target,
      releaseDir,
      mainBundle,
      previousDir,
      log,
      step,
    });

    if (!result.ok) {
      // Mark the release so the Releases list cannot present a build that never
      // served successfully as an ordinary rollback candidate.
      await markReleaseFailed(releaseDir, result.error);
      emit({
        type: 'error',
        message: result.error,
        rolledBack: result.rolledBack,
        releaseId: id,
      });
      return { ok: false, releaseId: id, error: result.error, rolledBack: result.rolledBack };
    }

    /* ---- prune ---- */
    step('prune', 'running');
    const removed = await pruneReleases(target, log);
    step('prune', 'ok');

    emit({
      type: 'done',
      releaseId: id,
      mainBundle,
      asserted: result.asserted,
      pruned: removed,
    });
    return { ok: true, releaseId: id, pruned: removed };
  } catch (err) {
    log(`error: ${err.message}`);
    // A failure before the swap leaves the site untouched; say so explicitly,
    // because "deploy failed" otherwise reads as "the site might be down".
    emit({
      type: 'error',
      message: err.message,
      code: err.code || 'DEPLOY_FAILED',
      rolledBack: false,
      liveUntouched: true,
    });
    return { ok: false, error: err.message, code: err.code };
  } finally {
    await releaseLock(lockPath);
    if (lockPath) log('lock: released');
  }
}

/** Manual rollback to an explicit release id, verified the same way. */
export async function rollbackRelease({ target, releaseIdToRestore, username, emit }) {
  const log = (message) => emit({ type: 'log', message });
  const step = (name, status) => emit({ type: 'step', name, status });

  let lockPath = null;
  try {
    await assertLiveLinkIsSymlink(target);
    lockPath = await acquireLock(target, username);
    log(`lock: acquired for ${target.key}`);

    const { releases } = await listReleases(target);
    const wanted = releases.find((r) => r.id === releaseIdToRestore);
    if (!wanted) {
      throw new DeployError(`No such release: ${releaseIdToRestore}`, 'NO_SUCH_RELEASE');
    }
    if (wanted.isLive) {
      throw new DeployError(`${releaseIdToRestore} is already live`, 'ALREADY_LIVE');
    }

    const previousDir = await currentLiveRelease(target);
    const meta = wanted.mainBundle
      ? wanted.mainBundle
      : findMainBundle(await listRelative(wanted.dir));

    log(`rollback target: ${wanted.dir} (deployed ${wanted.deployedAt || 'unknown'})`);

    const result = await swapRestartVerify({
      target,
      releaseDir: wanted.dir,
      mainBundle: meta,
      previousDir,
      log,
      step,
    });

    if (!result.ok) {
      emit({ type: 'error', message: result.error, rolledBack: result.rolledBack });
      return { ok: false, error: result.error };
    }

    emit({ type: 'done', releaseId: wanted.id, mainBundle: meta, asserted: result.asserted });
    return { ok: true, releaseId: wanted.id };
  } catch (err) {
    log(`error: ${err.message}`);
    emit({ type: 'error', message: err.message, code: err.code || 'ROLLBACK_FAILED' });
    return { ok: false, error: err.message, code: err.code };
  } finally {
    await releaseLock(lockPath);
    if (lockPath) log('lock: released');
  }
}

/* ----------------------------------------------------------------- utilities */

/**
 * Record that this release failed verification. Best-effort: a deploy that has
 * already failed must not fail again, louder, because of bookkeeping.
 */
async function markReleaseFailed(releaseDir, reason) {
  if (!releaseDir) return;
  const metaPath = path.join(releaseDir, 'meta.json');
  try {
    const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    meta.failed = true;
    meta.failureReason = reason;
    await fsp.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  } catch {
    /* meta.json may not exist yet if we failed during extraction */
  }
}

/** Avoid collisions when two deploys land in the same second. */
async function nextFreeReleaseId(target) {
  const base = releaseId();
  let candidate = base;
  let suffix = 1;
  /* eslint-disable no-await-in-loop */
  while (fs.existsSync(path.join(target.releasesDir, candidate))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
    if (suffix > 50) throw new DeployError('Cannot allocate a release id', 'DEPLOY_FAILED');
  }
  /* eslint-enable no-await-in-loop */
  return candidate;
}

/** Recursively list files under root, as root-relative paths. */
async function listRelative(root) {
  const out = [];
  async function walk(dir, prefix) {
    const dirents = await fsp.readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) await walk(path.join(dir, dirent.name), rel);
      else if (dirent.isFile()) out.push(rel);
    }
  }
  await walk(root, '');
  return out;
}

export { DeployError, listRelative };
