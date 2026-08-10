/**
 * staging.js — where uploaded archives wait between validation and commit.
 *
 * Uploads land here and nowhere else. The staging id is a server-generated
 * UUID; the client echoes it back on commit but can never widen it into a path,
 * because it is validated against a strict UUID pattern and then resolved
 * inside STAGING_ROOT.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertInside } from './targets.js';

export const STAGING_ROOT = path.join(process.cwd(), '.staging');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Staged uploads older than this are junk from an abandoned deploy. */
const STAGING_TTL_MS = 6 * 60 * 60 * 1000;

export async function createStagingDir() {
  const id = crypto.randomUUID();
  const dir = path.join(STAGING_ROOT, id);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  return { id, dir };
}

/** Resolve a client-supplied staging id to a directory, or throw. */
export function resolveStagingDir(id) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    throw new Error('Invalid staging id');
  }
  return assertInside(STAGING_ROOT, path.join(STAGING_ROOT, id));
}

export async function discardStaging(id) {
  try {
    const dir = resolveStagingDir(id);
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    /* nothing to discard */
  }
}

/**
 * Remove abandoned uploads. Called opportunistically on each new upload so a
 * 200MB zip from a deploy someone thought better of does not sit there forever.
 */
export async function sweepStaging() {
  let dirents;
  try {
    dirents = await fsp.readdir(STAGING_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }

  const swept = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || !UUID_RE.test(dirent.name)) continue;
    const dir = path.join(STAGING_ROOT, dirent.name);
    try {
      const stat = await fsp.stat(dir);
      if (Date.now() - stat.mtimeMs > STAGING_TTL_MS) {
        await fsp.rm(dir, { recursive: true, force: true });
        swept.push(dirent.name);
      }
    } catch {
      /* raced with another sweep */
    }
  }
  if (swept.length) console.log(`[staging] swept ${swept.length} abandoned upload(s)`);
  return swept;
}
