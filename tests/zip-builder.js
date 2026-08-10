/**
 * zip-builder.js — a minimal ZIP writer for test fixtures.
 *
 * We hand-craft archives rather than shelling out to `zip` because the hostile
 * cases cannot be produced portably otherwise: `zip` refuses to store a `../`
 * entry name, and symlink storage differs across platforms. Writing the bytes
 * ourselves is the only way to test the guard against the archive an attacker
 * would actually send.
 *
 * Entries are STORED (method 0), which yauzl reads like any other zip.
 */

import fs from 'node:fs';
import path from 'node:path';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

/**
 * @param {Array<{name: string, content?: string|Buffer, symlink?: boolean,
 *                dir?: boolean, mode?: number}>} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content == null ? '' : String(entry.content), 'utf8');
    const crc = crc32(data);

    // Unix mode goes in the high 16 bits of externalFileAttributes.
    let unixMode = entry.mode;
    if (unixMode == null) {
      if (entry.symlink) unixMode = S_IFLNK | 0o777;
      else if (entry.dir) unixMode = S_IFDIR | 0o755;
      else unixMode = S_IFREG | 0o644;
    }
    const externalAttrs = (unixMode << 16) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0x21, 12); // mod date (1996-01-01, arbitrary+valid)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory signature
    central.writeUInt16LE(0x031e, 4); // version made by: UNIX
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method: stored
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(externalAttrs, 38);
    central.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function writeZip(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buildZip(entries));
  return filePath;
}

/** A plausible Angular dist, optionally wrapped in a folder. */
function angularDistEntries(prefix = '', mainHash = '4f2a91c3d0e1b7a5') {
  const p = prefix ? `${prefix}/` : '';
  return [
    {
      name: `${p}index.html`,
      content: `<!doctype html><html><head><title>UBI</title></head><body><app-root></app-root><script src="main.${mainHash}.js" type="module"></script></body></html>`,
    },
    { name: `${p}main.${mainHash}.js`, content: `console.log("main ${mainHash}");` },
    { name: `${p}polyfills.9c1e2f.js`, content: 'console.log("polyfills");' },
    { name: `${p}styles.7b3a10.css`, content: 'body{margin:0}' },
    { name: `${p}assets/logo.svg`, content: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
  ];
}

export { buildZip, writeZip, crc32, angularDistEntries, S_IFLNK };
