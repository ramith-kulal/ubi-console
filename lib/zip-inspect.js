/**
 * zip-inspect.js — validate an uploaded build archive BEFORE anything live is
 * touched, and describe what deploying it would change.
 *
 * Every check here runs against the archive's *listing*, not its extracted
 * contents. yauzl streams the central directory, so a hostile archive is
 * rejected without a single byte being written to disk.
 *
 * The zip-slip guard (§5.2.2) is the check that matters most: archive
 * extraction is the classic path-traversal RCE. `../../../.ssh/authorized_keys`
 * inside a zip, extracted naively as the ubi-backend user, is a login. A
 * symlink entry is the same bug wearing a hat — extract `foo -> /etc`, then
 * write `foo/passwd`.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import yauzl from 'yauzl';

export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
export const MAX_UNCOMPRESSED_BYTES = 600 * 1024 * 1024; // zip-bomb ceiling
export const MAX_ENTRIES = 20000;
/** A stored/deflated ratio above this is a bomb, not a build. */
export const MAX_COMPRESSION_RATIO = 200;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

// Unix mode bits live in the high 16 of externalFileAttributes.
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

class ZipRejected extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ZipRejected';
    this.code = code || 'INVALID_ARCHIVE';
  }
}

/** Assert the first four bytes are a local file header. */
async function assertMagicBytes(zipPath) {
  const handle = await fsp.open(zipPath, 'r');
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buf, 0, 4, 0);
    if (bytesRead < 4 || !buf.equals(ZIP_MAGIC)) {
      throw new ZipRejected(
        'Not a zip archive: file does not start with the PK\\x03\\x04 signature. ' +
          'A renamed .tar.gz or a truncated upload looks exactly like this.',
        'NOT_A_ZIP'
      );
    }
  } finally {
    await handle.close();
  }
}

function isSymlinkEntry(entry) {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (unixMode & S_IFMT) === S_IFLNK;
}

function isDirectoryEntry(entry) {
  return /\/$/.test(entry.fileName);
}

/**
 * Reject any entry that could write outside the extraction root.
 * Returns the normalized, guaranteed-relative entry name.
 */
function assertSafeEntryName(rawName) {
  if (typeof rawName !== 'string' || rawName.length === 0) {
    throw new ZipRejected('Archive contains an entry with an empty name', 'ZIP_SLIP');
  }

  // Backslashes are path separators on the machine that may have produced the
  // zip; treat them as such rather than as literal filename characters.
  const name = rawName.replace(/\\/g, '/');

  if (name.includes('\0')) {
    throw new ZipRejected(
      `Archive entry contains a NUL byte: ${JSON.stringify(rawName)}`,
      'ZIP_SLIP'
    );
  }
  if (name.startsWith('/')) {
    throw new ZipRejected(
      `Archive contains an absolute path: ${rawName}`,
      'ZIP_SLIP'
    );
  }
  if (/^[a-zA-Z]:/.test(name)) {
    throw new ZipRejected(
      `Archive contains a drive-letter path: ${rawName}`,
      'ZIP_SLIP'
    );
  }
  // Any `..` segment, anywhere — not just a leading one. `a/../../b` escapes.
  if (name.split('/').some((segment) => segment === '..')) {
    throw new ZipRejected(
      `Archive contains a parent-directory traversal entry: ${rawName}`,
      'ZIP_SLIP'
    );
  }

  // Belt and braces: confirm the join actually stays under a sentinel root.
  const sentinel = path.resolve('/__extract_root__');
  const joined = path.resolve(sentinel, name);
  if (joined !== sentinel && !joined.startsWith(sentinel + path.sep)) {
    throw new ZipRejected(
      `Archive entry escapes the extraction root: ${rawName}`,
      'ZIP_SLIP'
    );
  }

  return name;
}

/**
 * Map yauzl's own path complaints onto our code. yauzl validates entry names
 * when it decodes them, but its message reads "corrupt zip", which would tell
 * an operator to re-download a build when the real answer is "this archive
 * tried to escape its directory". We open with decodeStrings:false so our
 * tested guard is the enforcement point; this mapping is the backstop.
 */
function mapYauzlError(err) {
  const msg = String(err && err.message ? err.message : err);
  if (/relative path|absolute path|invalid characters/i.test(msg)) {
    return new ZipRejected(`Unsafe archive entry: ${msg}`, 'ZIP_SLIP');
  }
  return new ZipRejected(`Corrupt zip: ${msg}`, 'NOT_A_ZIP');
}

/** Read the central directory. Resolves to an array of entry descriptors. */
function readEntries(zipPath) {
  return new Promise((resolve, reject) => {
    // decodeStrings:false hands us raw filename Buffers and skips yauzl's
    // internal name validation, so assertSafeEntryName() below is the single
    // place that decides what is safe — the thing the unit tests exercise.
    const options = { lazyEntries: true, autoClose: true, decodeStrings: false };
    yauzl.open(zipPath, options, (err, zipfile) => {
      if (err) {
        reject(mapYauzlError(err));
        return;
      }

      const entries = [];
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        try {
          zipfile.close();
        } catch {
          /* already closing */
        }
        reject(e);
      };

      zipfile.on('error', (e) => fail(mapYauzlError(e)));

      zipfile.on('entry', (entry) => {
        try {
          if (entries.length >= MAX_ENTRIES) {
            throw new ZipRejected(
              `Archive has more than ${MAX_ENTRIES} entries — refusing to process`,
              'TOO_MANY_ENTRIES'
            );
          }

          // decodeStrings:false means fileName arrives as a Buffer.
          const rawName = Buffer.isBuffer(entry.fileName)
            ? entry.fileName.toString('utf8')
            : entry.fileName;

          // Order matters: a symlink named "../x" should report as zip-slip, so
          // check the name first, then the type.
          const name = assertSafeEntryName(rawName);

          if (isSymlinkEntry(entry)) {
            throw new ZipRejected(
              `Archive contains a symlink entry (${rawName}). Symlinks in ` +
                'a build archive can redirect writes outside the release directory.',
              'ZIP_SLIP'
            );
          }

          entries.push({
            name,
            rawName,
            isDirectory: isDirectoryEntry({ fileName: rawName }),
            uncompressedSize: entry.uncompressedSize,
            compressedSize: entry.compressedSize,
            crc32: entry.crc32,
          });

          zipfile.readEntry();
        } catch (e) {
          fail(e);
        }
      });

      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(entries);
      });

      zipfile.readEntry();
    });
  });
}

/**
 * Archive noise that is never part of a build and must not influence root
 * detection. A Finder-created zip carries a `__MACOSX/` sibling folder and
 * `.DS_Store` files; counting those as real content makes a perfectly good
 * `dist/` archive look like it has two top-level folders.
 */
function isIgnorableEntry(name) {
  const segments = name.split('/');
  if (segments.includes('__MACOSX')) return true;
  const base = segments[segments.length - 1];
  return base === '.DS_Store' || base === 'Thumbs.db' || base.startsWith('._');
}

/**
 * Locate the directory that should become the release root.
 *
 * `ng build` does not put index.html at the top of its output. A multi-project
 * workspace emits `dist/<project-name>/index.html`, and Angular 17+ with the
 * application builder emits `dist/<project-name>/browser/index.html`. Assuming
 * at most one wrapper folder rejects both of those, so instead we find the
 * shallowest index.html and treat everything above it as the wrapper to strip.
 *
 * Returns { wrapper, indexPath }; throws with a description of what the archive
 * actually contains, because "no index.html" alone does not tell an operator
 * whether they grabbed a source zip or just nested it one level too deep.
 */
/**
 * An entry-point document that is not literally named index.html.
 *
 * angular.json can point a build configuration at a custom index document, and
 * the output keeps that name — e.g. `index.devubi.html`. That cannot be deployed
 * as-is: PM2_SERVE_SPA rewrites unknown paths to `index.html` specifically, so
 * such a build would serve nothing at all. We accept it and rename it on
 * extraction, but we say so in the plan rather than doing it silently.
 */
const INDEX_VARIANT_RE = /^index[.\-_][A-Za-z0-9._-]*\.html$/;

const basenameOf = (name) => name.slice(name.lastIndexOf('/') + 1);
const dirnameOf = (name) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '');

function resolveRoot(fileEntries) {
  const real = fileEntries.filter((e) => !isIgnorableEntry(e.name));

  const htmlEntries = real
    .map((e) => ({ name: e.name, base: basenameOf(e.name), depth: e.name.split('/').length - 1 }))
    .filter((e) => e.base === 'index.html' || INDEX_VARIANT_RE.test(e.base));

  if (htmlEntries.length === 0) {
    const topLevel = [...new Set(real.map((e) => e.name.split('/')[0]))].sort();
    throw new ZipRejected(
      'No index.html (or index.<name>.html) anywhere in this archive, so it is not a ' +
        'built frontend. Check whether a source zip was uploaded by mistake. ' +
        `Top-level contents: ${topLevel.slice(0, 8).join(', ')}${
          topLevel.length > 8 ? ', …' : ''
        }`,
      'NO_INDEX_HTML'
    );
  }

  // Depth dominates, and only then does the exact name break ties.
  //
  // Doing it the other way round is a trap: a real dist can contain a stray
  // `assets/icons/index.html` shipped by an icon pack, and preferring the exact
  // name first would pick that over the actual entry document one level from the
  // root — yielding a wrapper of `ubi-dist/assets/icons` and a release
  // containing nothing but icons.
  const minDepth = Math.min(...htmlEntries.map((e) => e.depth));
  const atMinDepth = htmlEntries.filter((e) => e.depth === minDepth);
  const exactAtMinDepth = atMinDepth.filter((e) => e.base === 'index.html');
  const shallowest = exactAtMinDepth.length > 0 ? exactAtMinDepth : atMinDepth;

  // Several candidates at the same depth means we cannot tell which tree is the
  // app (an archive holding two builds, or index.dev/index.prod side by side).
  // Never guess which one goes live.
  if (shallowest.length > 1) {
    throw new ZipRejected(
      `Ambiguous archive: ${shallowest.length} candidate entry documents at the same ` +
        `depth (${shallowest.map((e) => e.name).join(', ')}). ` +
        'Cannot determine which one should become index.html.',
      'AMBIGUOUS_ROOT'
    );
  }

  const indexPath = shallowest[0].name;
  const wrapper = dirnameOf(indexPath) || null;
  const indexBasename = basenameOf(indexPath);

  return {
    wrapper,
    indexPath,
    // Non-null only when the entry document is not already index.html, in which
    // case it is COPIED to index.html after extraction (the original is kept,
    // mirroring the `cp` the team does by hand today).
    indexCopyFrom: indexBasename === 'index.html' ? null : indexBasename,
  };
}

/** Strip the wrapper prefix so entry names line up with the deployed layout. */
function stripWrapper(name, wrapper) {
  if (!wrapper) return name;
  const prefix = `${wrapper}/`;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** The hashed Angular entry bundle, e.g. main.4f2a91c3d0e1b7a5.js. */
function findMainBundle(relativeNames) {
  const candidates = relativeNames.filter((n) =>
    /^(?:.*\/)?main[.-][A-Za-z0-9]+\.js$/.test(n)
  );
  if (candidates.length) return candidates.sort()[0];
  // Angular 17+ sometimes emits main.js with the hash only in the ESM chunk.
  const plain = relativeNames.filter((n) => /^(?:.*\/)?main\.js$/.test(n));
  return plain.length ? plain.sort()[0] : null;
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * Files the deployer itself writes into a release directory. They are our
 * bookkeeping, not part of the build, so they must not appear in the diff —
 * otherwise every release contains one file no archive has, and the
 * "identical to what is already live" warning could never fire at all.
 */
const DEPLOYER_ARTEFACTS = new Set(['meta.json']);

/**
 * List the files of the currently-live release so the UI can show a real diff.
 * A missing/never-migrated liveLink is not an error — it just means no diff.
 */
async function listLiveFiles(liveLink) {
  const out = new Map();
  let root;
  try {
    root = await fsp.realpath(liveLink);
  } catch {
    return null; // nothing live yet
  }

  async function walk(dir, prefix) {
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      const rel = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        await walk(full, rel);
      } else if (dirent.isFile()) {
        if (!prefix && DEPLOYER_ARTEFACTS.has(dirent.name)) continue;
        try {
          const st = await fsp.stat(full);
          out.set(rel, st.size);
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }

  await walk(root, '');
  return { root, files: out };
}

/**
 * Diff the archive against what is live.
 *
 * These two signals catch the failure modes the manual scp process cannot see:
 * a no-op redeploy (identical), and a build missing half its assets (a large
 * `removed` list).
 */
function buildDiff(newFiles, live) {
  if (!live) {
    return {
      hasLive: false,
      added: [],
      removed: [],
      changed: [],
      identical: false,
      liveRoot: null,
    };
  }

  const added = [];
  const changed = [];
  for (const [name, size] of newFiles) {
    if (!live.files.has(name)) added.push(name);
    else if (live.files.get(name) !== size) changed.push(name);
  }
  const removed = [...live.files.keys()].filter((name) => !newFiles.has(name));

  return {
    hasLive: true,
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
    identical: added.length === 0 && removed.length === 0 && changed.length === 0,
    liveRoot: live.root,
  };
}

/** Read the live release's main bundle name from its meta.json, if present. */
async function readLiveMainBundle(liveRoot) {
  if (!liveRoot) return null;
  try {
    const meta = JSON.parse(
      await fsp.readFile(path.join(liveRoot, 'meta.json'), 'utf8')
    );
    return meta.mainBundle || null;
  } catch {
    return null;
  }
}

/**
 * Validate `zipPath` and return a deploy plan.
 * Throws ZipRejected with a human-readable message on any failure.
 */
export async function inspectZip(zipPath, { liveLink } = {}) {
  const stat = await fsp.stat(zipPath);
  if (!stat.isFile()) {
    throw new ZipRejected('Upload is not a regular file', 'NOT_A_ZIP');
  }
  if (stat.size === 0) {
    throw new ZipRejected('Upload is empty (0 bytes)', 'NOT_A_ZIP');
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new ZipRejected(
      `Upload is ${(stat.size / 1024 / 1024).toFixed(1)} MB, over the ${
        MAX_UPLOAD_BYTES / 1024 / 1024
      } MB cap`,
      'TOO_LARGE'
    );
  }

  await assertMagicBytes(zipPath);

  const entries = await readEntries(zipPath);
  const fileEntries = entries.filter((e) => !e.isDirectory);

  if (fileEntries.length === 0) {
    throw new ZipRejected('Archive contains no files', 'EMPTY_ARCHIVE');
  }

  const totalUncompressed = fileEntries.reduce((n, e) => n + (e.uncompressedSize || 0), 0);
  if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
    throw new ZipRejected(
      `Archive expands to ${(totalUncompressed / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${MAX_UNCOMPRESSED_BYTES / 1024 / 1024} MB uncompressed cap (possible zip bomb)`,
      'ZIP_BOMB'
    );
  }
  const ratio = totalUncompressed / stat.size;
  if (stat.size > 1024 && ratio > MAX_COMPRESSION_RATIO) {
    throw new ZipRejected(
      `Archive compression ratio is ${ratio.toFixed(0)}:1, over the ` +
        `${MAX_COMPRESSION_RATIO}:1 limit (possible zip bomb)`,
      'ZIP_BOMB'
    );
  }

  const { wrapper, indexPath, indexCopyFrom } = resolveRoot(fileEntries);

  // Map of deployed-relative path -> uncompressed size. Names here are what
  // will exist on disk after extraction, so the noise filter and the index copy
  // are both applied — otherwise the diff against the live release compares
  // paths that will never exist.
  const newFiles = new Map();
  for (const e of fileEntries) {
    if (isIgnorableEntry(e.name)) continue;
    const rel = stripWrapper(e.name, wrapper);
    if (!rel) continue;
    newFiles.set(rel, e.uncompressedSize || 0);
  }
  if (indexCopyFrom && newFiles.has(indexCopyFrom)) {
    // The copy is a real file in the release, so it belongs in the diff.
    newFiles.set('index.html', newFiles.get(indexCopyFrom));
  }

  const live = liveLink ? await listLiveFiles(liveLink) : null;
  const diff = buildDiff(newFiles, live);

  const mainBundle = findMainBundle([...newFiles.keys()]);
  const liveMainBundle =
    (await readLiveMainBundle(diff.liveRoot)) ||
    (live ? findMainBundle([...live.files.keys()]) : null);

  const warnings = [];
  if (indexCopyFrom) {
    warnings.push(
      `This archive has no index.html — its entry document is "${indexCopyFrom}". ` +
        'It will be copied to index.html after extraction (the original is kept), ' +
        'because PM2_SERVE_SPA falls back to that exact filename and the site would ' +
        'otherwise serve nothing. Confirm this is the build you mean to put live.'
    );
  }
  if (diff.identical) {
    warnings.push(
      'This archive is byte-for-byte identical in filenames and sizes to the ' +
        'release already live. Deploying it would be a no-op.'
    );
  }
  if (!mainBundle) {
    // Not fatal — index.html proves it is a dist — but the health check in
    // §5.3.6 cannot assert the new build without a hashed bundle to look for.
    warnings.push(
      'No main.<hash>.js bundle found. The post-deploy health check will fall ' +
        'back to asserting index.html only, which cannot distinguish a stale build.'
    );
  }
  if (diff.hasLive && diff.removed.length > 0 && newFiles.size > 0) {
    const pct = Math.round((diff.removed.length / live.files.size) * 100);
    if (pct >= 25) {
      warnings.push(
        `This archive is missing ${diff.removed.length} file(s) (${pct}%) that exist in ` +
          'the live release. Check the build completed before deploying.'
      );
    }
  }

  return {
    ok: true,
    sha256: await sha256File(zipPath),
    zipBytes: stat.size,
    entryCount: fileEntries.length,
    totalUncompressedBytes: totalUncompressed,
    wrapper,
    indexPath,
    indexCopyFrom,
    mainBundle,
    liveMainBundle,
    files: [...newFiles.keys()].sort(),
    diff,
    warnings,
  };
}

export { ZipRejected, assertSafeEntryName, findMainBundle };
