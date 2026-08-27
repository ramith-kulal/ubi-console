/**
 * bypass.js — read, review, apply and roll back `src/config/bypass.json`, then
 * restart the process that reads it.
 *
 * The manual workflow this replaces is `nano src/config/bypass.json` followed by
 * `pm2 restart 0`, over SSH. Three things go wrong with that:
 *
 *   - nano writes an invalid JSON file just as happily as a valid one, and the
 *     backend then fails to boot on a file nobody kept a copy of;
 *   - `pm2 restart 0` addresses a process by index, and indexes move;
 *   - there is no record of who turned V1_ENCRYPTION_BYPASS on, or when.
 *
 * So: the file is parsed before and after, the write is atomic (temp file in the
 * same directory + rename, so the backend never reads a half-written config),
 * every write is preceded by a timestamped backup, the restart is by pm2 *name*,
 * the process is verified to come back online, and a failed restart restores the
 * backup automatically. Every applied change is appended to an audit log.
 *
 * Two properties this module keeps, matching lib/targets.js:
 *
 *   - The client sends a target KEY, never a path and never a command. Paths and
 *     the restart argv come from bypass-targets.json on the server.
 *   - The set of editable keys is the set of keys ALREADY IN THE FILE, with
 *     their existing types. The browser cannot invent a flag, cannot delete one,
 *     and cannot turn a boolean into an array. A typo'd flag name would be a
 *     flag the backend never reads — a bypass that silently does nothing is the
 *     worst outcome available here, so it is refused rather than written.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { assertInside } from './targets.js';

const TARGETS_PATH = path.join(process.cwd(), 'bypass-targets.json');

/** Where the audit trail is appended. Overridable so tests do not write to data/. */
function auditPath() {
  return process.env.BYPASS_AUDIT_PATH || path.join(process.cwd(), 'data', 'bypass-audit.jsonl');
}

const RESTART_TIMEOUT_MS = 60 * 1000;
const PM2_QUERY_TIMEOUT_MS = 20 * 1000;

/** Health poll schedule (ms). A pm2 restart settles in ~1-3s in practice. */
const HEALTH_BACKOFF_MS = [700, 1000, 1500, 2500, 4000, 6000];

/** Array items are flag/field names in the backend, so keep them identifier-ish. */
const TOKEN_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A single-line printable string. Newlines in a config value are never wanted. */
const STRING_RE = /^[\x20-\x7e]{0,200}$/;

const MAX_ARRAY_ITEMS = 64;
const MAX_CHANGES = 100;

export const BACKUP_ID_RE = /^\d{8}-\d{6}(?:-[A-Za-z0-9_.-]{1,32})?$/;

export class BypassError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'BypassError';
    this.code = code || 'BYPASS_FAILED';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/* ------------------------------------------------------------ target allowlist */

let targetCache = null;

function loadTargets() {
  if (targetCache) return targetCache;
  const raw = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));

  for (const [key, t] of Object.entries(raw)) {
    // Fail at load time rather than half way through a write.
    for (const field of ['label', 'pm2Name', 'configPath', 'backupsDir']) {
      if (typeof t[field] !== 'string' || !t[field]) {
        throw new Error(`bypass-targets.json: ${key}.${field} must be a non-empty string`);
      }
    }
    if (!Array.isArray(t.restartCommand) || t.restartCommand.length < 1) {
      throw new Error(`bypass-targets.json: ${key}.restartCommand must be a non-empty array`);
    }
    if (!t.restartCommand.every((a) => typeof a === 'string' && a.length)) {
      throw new Error(`bypass-targets.json: ${key}.restartCommand must be strings`);
    }
    if (t.statusCommand != null) {
      if (
        !Array.isArray(t.statusCommand) ||
        t.statusCommand.length < 1 ||
        !t.statusCommand.every((a) => typeof a === 'string' && a.length)
      ) {
        throw new Error(`bypass-targets.json: ${key}.statusCommand must be an array of strings`);
      }
    }
    if (!path.isAbsolute(t.configPath) || !path.isAbsolute(t.backupsDir)) {
      throw new Error(`bypass-targets.json: ${key} paths must be absolute`);
    }
    if (t.healthUrl != null && typeof t.healthUrl !== 'string') {
      throw new Error(`bypass-targets.json: ${key}.healthUrl must be a string or null`);
    }
    if (!Number.isInteger(t.keepBackups) || t.keepBackups < 1) {
      throw new Error(`bypass-targets.json: ${key}.keepBackups must be a positive integer`);
    }
  }

  targetCache = raw;
  return targetCache;
}

/** Safe to send to the browser: no argv, no commands. */
export function listBypassTargets() {
  return Object.entries(loadTargets()).map(([key, t]) => ({
    key,
    label: t.label,
    pm2Name: t.pm2Name,
    configPath: t.configPath,
    healthUrl: t.healthUrl || null,
    keepBackups: t.keepBackups,
  }));
}

/** Resolve a client-supplied key, or null. Never throws. */
export function getBypassTarget(key) {
  if (typeof key !== 'string') return null;
  const targets = loadTargets();
  if (!Object.prototype.hasOwnProperty.call(targets, key)) return null;
  return { key, ...targets[key] };
}

/* ------------------------------------------------------------------ value types */

/**
 * The editable shape of a value, derived from what is in the file today.
 *
 * `readonly` covers nested objects, null and mixed arrays: they are shown so the
 * screen is an honest view of the file, but changing them needs a human with an
 * editor, not a form with a text box.
 */
export function classifyValue(value) {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return 'stringArray';
  return 'readonly';
}

/** Per-key description for the UI, in file order. */
export function describeKeys(config) {
  return Object.keys(config).map((key) => {
    const type = classifyValue(config[key]);
    return { key, type, value: config[key], editable: type !== 'readonly' };
  });
}

/**
 * Coerce and validate an incoming value against the type already in the file.
 * The type must match exactly — this is a value editor, not a schema editor.
 */
function coerceValue(type, incoming, key) {
  if (type === 'boolean') {
    if (typeof incoming !== 'boolean') {
      throw new BypassError(`${key} is a boolean; got ${typeof incoming}`, 'TYPE_MISMATCH');
    }
    return incoming;
  }

  if (type === 'number') {
    const n = typeof incoming === 'string' ? Number(incoming.trim()) : incoming;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new BypassError(`${key} is a number; got ${JSON.stringify(incoming)}`, 'TYPE_MISMATCH');
    }
    if (Math.abs(n) > 1e12) {
      throw new BypassError(`${key}: value out of range`, 'VALUE_REJECTED');
    }
    return n;
  }

  if (type === 'string') {
    if (typeof incoming !== 'string') {
      throw new BypassError(`${key} is a string; got ${typeof incoming}`, 'TYPE_MISMATCH');
    }
    if (!STRING_RE.test(incoming)) {
      throw new BypassError(
        `${key}: only printable single-line text up to 200 characters is accepted here`,
        'VALUE_REJECTED'
      );
    }
    return incoming;
  }

  if (type === 'stringArray') {
    if (!Array.isArray(incoming)) {
      throw new BypassError(`${key} is a list; got ${typeof incoming}`, 'TYPE_MISMATCH');
    }
    if (incoming.length > MAX_ARRAY_ITEMS) {
      throw new BypassError(`${key}: at most ${MAX_ARRAY_ITEMS} entries`, 'VALUE_REJECTED');
    }
    const out = [];
    for (const item of incoming) {
      if (typeof item !== 'string' || !TOKEN_RE.test(item)) {
        throw new BypassError(
          `${key}: "${String(item).slice(0, 40)}" is not a valid entry ` +
            '(letters, digits, and . _ - only)',
          'VALUE_REJECTED'
        );
      }
      // Duplicates are refused rather than silently collapsed: the reviewed diff
      // must be the bytes that get written.
      if (out.includes(item)) {
        throw new BypassError(`${key}: "${item}" is listed twice`, 'VALUE_REJECTED');
      }
      out.push(item);
    }
    return out;
  }

  throw new BypassError(`${key} cannot be edited from this screen`, 'READONLY_KEY');
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Turn a `{KEY: value}` patch from the browser into a validated change list.
 * Keys whose value already matches are dropped, so "toggle and toggle back" is
 * not a write.
 */
export function planChanges(config, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new BypassError('changes must be an object of key → value', 'INVALID_CHANGES');
  }

  const entries = Object.entries(patch);
  if (entries.length > MAX_CHANGES) {
    throw new BypassError(`too many keys in one change (max ${MAX_CHANGES})`, 'INVALID_CHANGES');
  }

  const changes = [];
  for (const [key, incoming] of entries) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) {
      throw new BypassError(
        `"${key}" is not a key in this file. Flags must already exist to be changed here — ` +
          'add a new one by editing the file on the instance.',
        'UNKNOWN_KEY'
      );
    }

    const current = config[key];
    const type = classifyValue(current);
    if (type === 'readonly') {
      throw new BypassError(
        `"${key}" holds a nested value and cannot be edited from this screen`,
        'READONLY_KEY'
      );
    }

    const next = coerceValue(type, incoming, key);
    if (same(next, current)) continue;
    changes.push({ key, type, from: current, to: next });
  }

  if (!changes.length) {
    throw new BypassError('Nothing would change — the file already has these values', 'NO_CHANGES');
  }

  return changes;
}

/** Apply a change list to a config object. Key order is preserved. */
export function applyChanges(config, changes) {
  const next = { ...config };
  for (const change of changes) next[change.key] = change.to;
  return next;
}

/**
 * A change that turns a bypass ON deserves louder treatment than one that turns
 * it off: enabling a bypass is what weakens a check.
 */
export function enablingChanges(changes) {
  return changes.filter(
    (c) =>
      (c.type === 'boolean' && c.to === true && c.from !== true) ||
      (c.type === 'stringArray' && c.to.length > c.from.length)
  );
}

/* ------------------------------------------------------------------ serializing */

/** Match the file's own indentation so the diff stays small and reviewable. */
export function detectIndent(text) {
  const match = /\n([ \t]+)"/.exec(text);
  if (!match) return 4;
  return match[1].includes('\t') ? '\t' : match[1].length;
}

export function serializeConfig(config, indent) {
  return `${JSON.stringify(config, null, indent)}\n`;
}

/* -------------------------------------------------------------------- reading */

export async function readConfig(target) {
  let text;
  try {
    text = await fsp.readFile(target.configPath, 'utf8');
  } catch (err) {
    throw new BypassError(
      `Cannot read ${target.configPath}: ${err.code === 'ENOENT' ? 'file does not exist' : err.message}`,
      'CONFIG_UNREADABLE'
    );
  }

  let config;
  try {
    config = JSON.parse(text);
  } catch (err) {
    throw new BypassError(
      `${target.configPath} is not valid JSON (${err.message}). Fix it on the instance first — ` +
        'this screen will not overwrite a file it cannot read.',
      'CONFIG_MALFORMED'
    );
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new BypassError(`${target.configPath} must contain a JSON object`, 'CONFIG_MALFORMED');
  }

  const indent = detectIndent(text);

  return {
    text,
    config,
    indent,
    sha256: sha256(text),
    keys: describeKeys(config),
    // True when re-serializing would change bytes beyond the edited values, i.e.
    // the file's current formatting is not what this tool writes.
    reformats: serializeConfig(config, indent) !== text,
  };
}

/* --------------------------------------------------------------------- writing */

let tmpCounter = 0;

/**
 * Write via a temp file in the same directory + rename.
 *
 * `require('./bypass.json')` in a running backend can read a file mid-write; a
 * rename is atomic on the same filesystem, so a reader sees either the old file
 * or the new one and never a truncated one.
 */
async function writeAtomic(filePath, text) {
  const dir = path.dirname(filePath);

  let mode = 0o644;
  try {
    mode = (await fsp.stat(filePath)).mode & 0o777;
  } catch {
    /* first write — keep the default */
  }

  tmpCounter += 1;
  const tmp = path.join(dir, `.bypass-write.${process.pid}.${tmpCounter}.tmp`);
  const handle = await fsp.open(tmp, 'w', mode);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await fsp.chmod(tmp, mode);
    await fsp.rename(tmp, filePath);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

/* --------------------------------------------------------------------- backups */

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function safeUser(username) {
  const cleaned = String(username || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '');
  return cleaned.slice(0, 32) || 'unknown';
}

export function backupFileFor(target, id) {
  return assertInside(target.backupsDir, path.join(target.backupsDir, `bypass-${id}.json`));
}

/** Copy the current file aside. Returns the backup id, or null if there is no file yet. */
export async function backupConfig(target, username) {
  await fsp.mkdir(target.backupsDir, { recursive: true });

  // A second write inside the same second must not overwrite the first backup.
  const base = `${stamp()}-${safeUser(username)}`;
  let id = base;
  for (let n = 2; fs.existsSync(backupFileFor(target, id)); n += 1) {
    id = `${base}.${n}`;
    if (n > 50) throw new BypassError('cannot allocate a backup name', 'BACKUP_FAILED');
  }

  const file = backupFileFor(target, id);
  await fsp.copyFile(target.configPath, file);
  return { id, file };
}

export async function listBackups(target) {
  let names;
  try {
    names = await fsp.readdir(target.backupsDir);
  } catch {
    return [];
  }

  const out = [];
  for (const name of names) {
    const match = /^bypass-(.+)\.json$/.exec(name);
    if (!match) continue;
    const id = match[1];
    if (!BACKUP_ID_RE.test(id.replace(/\.\d+$/, ''))) continue;
    try {
      const stats = await fsp.stat(path.join(target.backupsDir, name));
      out.push({
        id,
        bytes: stats.size,
        at: stats.mtime.toISOString(),
        by: /^\d{8}-\d{6}-(.+?)(?:\.\d+)?$/.exec(id)?.[1] || null,
      });
    } catch {
      /* vanished between readdir and stat */
    }
  }

  // Newest first: the id sorts chronologically by construction.
  return out.sort((a, b) => (a.id < b.id ? 1 : -1));
}

export async function readBackup(target, id) {
  if (typeof id !== 'string' || !BACKUP_ID_RE.test(id.replace(/\.\d+$/, ''))) {
    throw new BypassError('Invalid backup id', 'INVALID_BACKUP');
  }
  const file = backupFileFor(target, id);
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    throw new BypassError(`No such backup: ${id}`, 'INVALID_BACKUP');
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch (err) {
    throw new BypassError(`Backup ${id} is not valid JSON (${err.message})`, 'INVALID_BACKUP');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new BypassError(`Backup ${id} does not contain a JSON object`, 'INVALID_BACKUP');
  }
  return { text, config, sha256: sha256(text) };
}

async function pruneBackups(target, log) {
  const backups = await listBackups(target);
  const doomed = backups.slice(target.keepBackups);
  for (const backup of doomed) {
    try {
      await fsp.rm(backupFileFor(target, backup.id), { force: true });
      if (log) log(`prune: removed backup ${backup.id}`);
    } catch (err) {
      if (log) log(`prune: could not remove ${backup.id} — ${err.message}`);
    }
  }
  return doomed.length;
}

/**
 * A key-by-key diff between two config objects, for showing what a restore does.
 */
export function diffConfigs(from, to) {
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])];
  const out = [];
  for (const key of keys) {
    const hasFrom = Object.prototype.hasOwnProperty.call(from, key);
    const hasTo = Object.prototype.hasOwnProperty.call(to, key);
    if (hasFrom && hasTo) {
      if (!same(from[key], to[key])) {
        out.push({ key, kind: 'changed', from: from[key], to: to[key] });
      }
    } else if (hasTo) {
      out.push({ key, kind: 'added', from: undefined, to: to[key] });
    } else {
      out.push({ key, kind: 'removed', from: from[key], to: undefined });
    }
  }
  return out;
}

/* --------------------------------------------------------------------- restart */

function execFileAsync(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8', env: process.env }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        stdout: stdout || '',
        stderr: stderr || (err ? err.message : ''),
      });
    });
  });
}

/**
 * argv array, no shell — same rule as lib/deploy.js. The command comes from the
 * allowlist file, so there is nothing to interpolate, and keeping it that way
 * means a future dynamic value cannot become an injection sink.
 */
export function runRestart(target) {
  const [cmd, ...args] = target.restartCommand;
  return execFileAsync(cmd, args, RESTART_TIMEOUT_MS);
}

/** Parse `pm2 jlist` and pick out this target's process. */
export async function pm2Snapshot(target) {
  // Same binary as the restart unless the target says otherwise.
  const argv = Array.isArray(target.statusCommand)
    ? target.statusCommand
    : [target.restartCommand[0], 'jlist'];
  const pm2 = argv[0];

  const result = await execFileAsync(pm2, argv.slice(1), PM2_QUERY_TIMEOUT_MS);
  if (!result.ok) {
    return { ok: false, reason: result.stderr.trim() || `${pm2} jlist exited ${result.code}` };
  }

  // pm2 sometimes prefixes the JSON with a banner line.
  const start = result.stdout.indexOf('[');
  const end = result.stdout.lastIndexOf(']');
  if (start === -1 || end <= start) {
    return { ok: false, reason: `${pm2} jlist did not return JSON` };
  }

  let list;
  try {
    list = JSON.parse(result.stdout.slice(start, end + 1));
  } catch (err) {
    return { ok: false, reason: `${pm2} jlist output is unparseable (${err.message})` };
  }

  const entry = (Array.isArray(list) ? list : []).find((p) => p && p.name === target.pm2Name);
  if (!entry) {
    return { ok: false, reason: `pm2 has no process named ${target.pm2Name}` };
  }

  const env = entry.pm2_env || {};
  return {
    ok: true,
    name: entry.name,
    pmId: entry.pm_id,
    pid: entry.pid || null,
    status: env.status || 'unknown',
    restarts: Number.isInteger(env.restart_time) ? env.restart_time : null,
    unstableRestarts: Number.isInteger(env.unstable_restarts) ? env.unstable_restarts : 0,
    uptimeMs: env.pm_uptime ? Date.now() - env.pm_uptime : null,
  };
}

/**
 * Verify the process actually came back.
 *
 * A crash-looping app is `online` for a fraction of a second at a time, so one
 * `online` sample proves nothing. Two consecutive samples with the SAME restart
 * count means it started and stayed started — which is exactly the failure mode
 * a bad bypass.json produces (backend throws at boot, pm2 keeps retrying).
 */
export async function healthCheck(target, log) {
  const backoff = Array.isArray(target.healthBackoffMs) ? target.healthBackoffMs : HEALTH_BACKOFF_MS;
  let previous = null;

  for (let i = 0; i < backoff.length; i += 1) {
    await sleep(backoff[i]);

    const snapshot = await pm2Snapshot(target);
    if (!snapshot.ok) {
      log(`health: attempt ${i + 1}/${backoff.length} — ${snapshot.reason}`);
      previous = null;
      continue;
    }

    if (snapshot.status !== 'online') {
      log(
        `health: attempt ${i + 1}/${backoff.length} — ${target.pm2Name} is ` +
          `${snapshot.status} (restarts ${snapshot.restarts})`
      );
      previous = null;
      continue;
    }

    if (previous === null || previous !== snapshot.restarts) {
      log(
        `health: attempt ${i + 1}/${backoff.length} — online, restarts ${snapshot.restarts}; ` +
          'confirming it stays up'
      );
      previous = snapshot.restarts;
      continue;
    }

    // Stable. Optionally require the HTTP endpoint to answer as well.
    if (target.healthUrl) {
      const http = await probeHttp(target.healthUrl);
      if (!http.ok) {
        log(`health: attempt ${i + 1}/${backoff.length} — ${target.healthUrl} ${http.detail}`);
        continue;
      }
      log(`health: OK — ${target.pm2Name} online and ${target.healthUrl} ${http.detail}`);
      return { ok: true, asserted: 'pm2+http', snapshot };
    }

    log(
      `health: OK — ${target.pm2Name} online and stable at ${snapshot.restarts} restarts ` +
        `(pid ${snapshot.pid}). NOTE: no healthUrl is configured for this target, so this ` +
        'asserts the process is up, not that it serves correct responses.'
    );
    return { ok: true, asserted: 'pm2', snapshot };
  }

  return { ok: false };
}

/** Any answer below 500 means the app is serving; a 404 on `/` is normal for an API. */
async function probeHttp(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'cache-control': 'no-cache' },
    });
    clearTimeout(timer);
    if (res.status >= 500) return { ok: false, detail: `returned HTTP ${res.status}` };
    return { ok: true, detail: `answered HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `did not answer (${err.message})` };
  }
}

/* ----------------------------------------------------------------- audit trail */

/**
 * Append-only record of every applied change.
 *
 * These flags disable OTP checks, encryption and credit-bureau calls. "Who
 * turned this on, and is it still on" is a question that gets asked after the
 * fact, and by then the pm2 log has rotated.
 */
export async function appendAudit(entry) {
  try {
    const file = auditPath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (err) {
    // An unwritable audit log must not fail a change that already happened.
    console.error('[bypass] audit append failed:', err.message);
  }
}

export async function readAudit(limit = 25) {
  let text;
  try {
    text = await fsp.readFile(auditPath(), 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n').filter(Boolean).slice(-limit).reverse();
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/* ----------------------------------------------------------------- apply flow */

/**
 * Write `nextText`, restart, verify, and restore the backup if it does not come
 * back. Shared by "apply changes" and "restore a backup" — the risky half is
 * identical and there is no reason for two copies of it.
 *
 * `emit` receives the same event shape as the deployer: log / step / done / error.
 */
async function writeRestartVerify({ target, nextText, username, summary, audit, emit }) {
  const log = (message) => emit({ type: 'log', message });
  const step = (name, status) => emit({ type: 'step', name, status });

  /* ---- backup ---- */
  step('backup', 'running');
  let backup = null;
  try {
    backup = await backupConfig(target, username);
    log(`backup: current file copied to ${backup.file}`);
    step('backup', 'ok');
  } catch (err) {
    step('backup', 'failed');
    emit({
      type: 'error',
      message: `Could not back up the current file: ${err.message}`,
      configUntouched: true,
    });
    return { ok: false };
  }

  /* ---- write ---- */
  step('write', 'running');
  try {
    await writeAtomic(target.configPath, nextText);
    log(`write: ${target.configPath} updated (${Buffer.byteLength(nextText)} bytes)`);
    step('write', 'ok');
  } catch (err) {
    step('write', 'failed');
    emit({
      type: 'error',
      message: `Write failed: ${err.message}`,
      configUntouched: true,
    });
    return { ok: false };
  }

  // Recorded as soon as the bytes are on disk, before the restart. If this
  // console dies mid-flow the log still says the file was changed and by whom.
  await appendAudit({ ...audit, at: new Date().toISOString(), backupId: backup.id, phase: 'written' });

  /* ---- restart ---- */
  step('restart', 'running');
  const restart = await runRestart(target);
  if (restart.stdout.trim()) log(`pm2 stdout: ${restart.stdout.trim()}`);
  if (restart.stderr.trim()) log(`pm2 stderr: ${restart.stderr.trim()}`);

  if (!restart.ok) {
    step('restart', 'failed');
    log(`restart: ${target.restartCommand.join(' ')} exited ${restart.code}`);
    const restored = await restore(target, backup, log, step);
    await appendAudit({
      ...audit,
      at: new Date().toISOString(),
      backupId: backup.id,
      phase: restored ? 'rolled-back' : 'restart-failed-not-rolled-back',
    });
    emit({
      type: 'error',
      message: `pm2 restart failed (exit ${restart.code}). ${restart.stderr.trim()}`,
      rolledBack: restored,
      backupId: backup.id,
    });
    return { ok: false, backup };
  }
  log(`restart: ${target.restartCommand.join(' ')} exited 0`);
  step('restart', 'ok');

  /* ---- verify ---- */
  step('health', 'running');
  const health = await healthCheck(target, log);
  if (!health.ok) {
    step('health', 'failed');
    log(`health: ${target.pm2Name} did not come back up — restoring the previous file`);
    const restored = await restore(target, backup, log, step);
    await appendAudit({
      ...audit,
      at: new Date().toISOString(),
      backupId: backup.id,
      phase: restored ? 'rolled-back' : 'unhealthy-not-rolled-back',
    });
    emit({
      type: 'error',
      message:
        `${target.pm2Name} did not come back online after the restart. ` +
        (restored
          ? 'The previous bypass.json was restored and the process restarted again.'
          : 'The previous file could NOT be restored automatically — see the log.'),
      rolledBack: restored,
      backupId: backup.id,
    });
    return { ok: false, backup };
  }
  step('health', 'ok');

  step('prune', 'running');
  const pruned = await pruneBackups(target, log);
  step('prune', 'ok');
  if (pruned === 0) log('prune: nothing to remove');

  await appendAudit({
    ...audit,
    at: new Date().toISOString(),
    backupId: backup.id,
    phase: 'verified',
  });

  emit({
    type: 'done',
    summary,
    backupId: backup.id,
    asserted: health.asserted,
    process: health.snapshot,
  });
  return { ok: true, backup };
}

/** Put the backup back and restart again. Returns true if the process is up. */
async function restore(target, backup, log, step) {
  step('rollback', 'running');
  try {
    const text = await fsp.readFile(backup.file, 'utf8');
    await writeAtomic(target.configPath, text);
    log(`rollback: restored ${target.configPath} from backup ${backup.id}`);

    const restart = await runRestart(target);
    if (restart.stderr.trim()) log(`rollback pm2 stderr: ${restart.stderr.trim()}`);
    if (!restart.ok) {
      log(`rollback: pm2 restart FAILED (exit ${restart.code})`);
      log(`rollback: the file is back to its previous contents, but ${target.pm2Name} could ` +
        'not be restarted — restart it by hand');
      step('rollback', 'failed');
      return false;
    }

    const health = await healthCheck(target, log);
    if (!health.ok) {
      log('rollback: the previous file is back in place but the process is still not online');
      log(`rollback: this is now a ${target.pm2Name} problem, not a config problem`);
      step('rollback', 'failed');
      return false;
    }

    log('rollback: complete — the previous file is live and the process is online');
    step('rollback', 'ok');
    return true;
  } catch (err) {
    log(`rollback: FAILED — ${err.message}`);
    log(`rollback: the backup is at ${backup.file} — restore it by hand`);
    step('rollback', 'failed');
    return false;
  }
}

/**
 * Apply a validated change list.
 *
 * `expectedSha256` is the digest of the file as it was when the operator read
 * it. If the file has changed since — someone editing over SSH at the same time
 * — the change is refused rather than silently overwriting their edit.
 */
export async function applyBypassChanges({
  target,
  changes,
  expectedSha256,
  expectedNextSha256,
  username,
  emit,
}) {
  const log = (message) => emit({ type: 'log', message });

  let current;
  try {
    current = await readConfig(target);
  } catch (err) {
    emit({ type: 'error', message: err.message, code: err.code, configUntouched: true });
    return { ok: false };
  }

  if (expectedSha256 && current.sha256 !== expectedSha256) {
    emit({
      type: 'error',
      message:
        'The file on disk has changed since you loaded this screen (someone else edited it). ' +
        'Reload and review again — nothing was written.',
      code: 'STALE_READ',
      configUntouched: true,
    });
    return { ok: false };
  }

  // Re-validate against the file we just read, not against whatever the plan
  // step saw. This is what makes the change list authoritative.
  let validated;
  try {
    validated = planChanges(current.config, Object.fromEntries(changes.map((c) => [c.key, c.to])));
  } catch (err) {
    emit({ type: 'error', message: err.message, code: err.code, configUntouched: true });
    return { ok: false };
  }

  const nextText = serializeConfig(applyChanges(current.config, validated), current.indent);

  // The last gate: the file about to be written must hash to the file that was
  // reviewed. Belt and braces alongside the confirm token, which binds the same
  // digest — a mismatch here means the plan and the apply disagree, and the only
  // safe response is to write nothing.
  if (expectedNextSha256 && sha256(nextText) !== expectedNextSha256) {
    emit({
      type: 'error',
      message:
        'The change no longer produces the file that was reviewed. Reload and review again — ' +
        'nothing was written.',
      code: 'PLAN_MISMATCH',
      configUntouched: true,
    });
    return { ok: false };
  }

  for (const change of validated) {
    log(`change: ${change.key}  ${JSON.stringify(change.from)} → ${JSON.stringify(change.to)}`);
  }

  const enabling = enablingChanges(validated);
  if (enabling.length) {
    log(`note: ${enabling.length} bypass(es) are being ENABLED, which relaxes a check`);
  }

  return writeRestartVerify({
    target,
    nextText,
    username,
    summary: `${validated.length} flag(s) changed`,
    audit: {
      action: 'apply',
      target: target.key,
      user: username,
      changes: validated.map((c) => ({ key: c.key, from: c.from, to: c.to })),
    },
    emit,
  });
}

/** Put a previous version of the whole file back. */
export async function restoreBypassBackup({ target, backupId, expectedSha256, username, emit }) {
  const log = (message) => emit({ type: 'log', message });

  let current;
  let backup;
  try {
    current = await readConfig(target);
    backup = await readBackup(target, backupId);
  } catch (err) {
    emit({ type: 'error', message: err.message, code: err.code, configUntouched: true });
    return { ok: false };
  }

  if (expectedSha256 && current.sha256 !== expectedSha256) {
    emit({
      type: 'error',
      message:
        'The file on disk has changed since you loaded this screen. Reload and review again — ' +
        'nothing was written.',
      code: 'STALE_READ',
      configUntouched: true,
    });
    return { ok: false };
  }

  const diff = diffConfigs(current.config, backup.config);
  if (!diff.length) {
    emit({
      type: 'error',
      message: `Backup ${backupId} is identical to the current file — nothing to restore.`,
      code: 'NO_CHANGES',
      configUntouched: true,
    });
    return { ok: false };
  }

  for (const entry of diff) {
    log(
      `restore ${entry.kind}: ${entry.key}  ${JSON.stringify(entry.from)} → ` +
        `${JSON.stringify(entry.to)}`
    );
  }

  return writeRestartVerify({
    target,
    // The backup's own bytes, verbatim — a restore should reproduce the file
    // that was known to work, formatting included.
    nextText: backup.text.endsWith('\n') ? backup.text : `${backup.text}\n`,
    username,
    summary: `restored backup ${backupId}`,
    audit: {
      action: 'restore',
      target: target.key,
      user: username,
      restoredFrom: backupId,
      changes: diff.map((d) => ({ key: d.key, from: d.from, to: d.to })),
    },
    emit,
  });
}
