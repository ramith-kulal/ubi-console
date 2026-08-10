/**
 * targets.js — server-side deploy target allowlist.
 *
 * Imported only by Next route handlers under app/api/deploy/* , all of which
 * run with `export const runtime = 'nodejs'`.
 *
 * The client sends ONLY a target key. Any path or command arriving from the
 * browser is a bug, not a feature: resolving a client-supplied path would turn
 * this app into "write anywhere as the ubi-backend user, then run it".
 */

import fs from 'node:fs';
import path from 'node:path';

const TARGETS_PATH = path.join(process.cwd(), 'deploy-targets.json');

let cache = null;

function load() {
  if (cache) return cache;
  const raw = JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));

  for (const [key, t] of Object.entries(raw)) {
    // Fail at load time, not mid-deploy, if the allowlist is malformed.
    for (const field of ['label', 'liveLink', 'releasesDir', 'healthUrl']) {
      if (typeof t[field] !== 'string' || !t[field]) {
        throw new Error(`deploy-targets.json: ${key}.${field} must be a non-empty string`);
      }
    }
    if (!Array.isArray(t.restartCommand) || t.restartCommand.length < 1) {
      throw new Error(`deploy-targets.json: ${key}.restartCommand must be a non-empty array`);
    }
    if (!path.isAbsolute(t.liveLink) || !path.isAbsolute(t.releasesDir)) {
      throw new Error(`deploy-targets.json: ${key} paths must be absolute`);
    }
    if (!Number.isInteger(t.keepReleases) || t.keepReleases < 1) {
      throw new Error(`deploy-targets.json: ${key}.keepReleases must be a positive integer`);
    }
  }

  cache = raw;
  return cache;
}

/** Safe to send to the browser: labels and read-only metadata, no commands. */
export function listTargets() {
  const targets = load();
  return Object.entries(targets).map(([key, t]) => ({
    key,
    label: t.label,
    pm2Name: t.pm2Name || t.restartCommand[t.restartCommand.length - 1],
    healthUrl: t.healthUrl,
    keepReleases: t.keepReleases,
    liveLink: t.liveLink,
    releasesDir: t.releasesDir,
  }));
}

/** Resolve a client-supplied key to a target, or null. Never throws. */
export function getTarget(key) {
  if (typeof key !== 'string') return null;
  const targets = load();
  if (!Object.prototype.hasOwnProperty.call(targets, key)) return null;
  return { key, ...targets[key] };
}

/**
 * Assert a computed path stays inside `root`. Called before every write and
 * every delete, so a bug upstream cannot escape the releases directory.
 */
export function assertInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`refusing to touch ${resolved}: outside ${resolvedRoot}`);
  }
  return resolved;
}
