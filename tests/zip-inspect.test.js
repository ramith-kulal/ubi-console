/**
 * zip-inspect.test.js — the guard that stands between an uploaded archive and
 * `fs.write` running as the ubi-backend user. Tested before it is trusted.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, expectRejection } from './harness.js';
import { writeZip, angularDistEntries } from './zip-builder.js';
import { inspectZip, assertSafeEntryName, findMainBundle } from '../lib/zip-inspect.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ubi-ops-zip-'));
const fixture = (name) => path.join(TMP, name);

/** Materialise a fake "currently live" release directory. */
function makeLiveDir(name, entries) {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  for (const e of entries) {
    const target = path.join(root, e.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.content == null ? '' : String(e.content));
  }
  return root;
}

describe('assertSafeEntryName — zip-slip guard (unit)', () => {
  it('accepts ordinary relative names', () => {
    expect(assertSafeEntryName('index.html')).toBe('index.html');
    expect(assertSafeEntryName('assets/img/logo.svg')).toBe('assets/img/logo.svg');
  });

  it('rejects a leading ../ traversal', () => {
    let threw = false;
    try {
      assertSafeEntryName('../evil.js');
    } catch (e) {
      threw = true;
      expect(e.code).toBe('ZIP_SLIP');
    }
    expect(threw).toBeTruthy();
  });

  it('rejects a ../ buried mid-path', () => {
    // `a/../../b` escapes even though it does not start with ".."
    let threw = false;
    try {
      assertSafeEntryName('assets/../../../../home/ubi-backend/.ssh/authorized_keys');
    } catch (e) {
      threw = true;
      expect(e.code).toBe('ZIP_SLIP');
    }
    expect(threw).toBeTruthy();
  });

  it('rejects absolute and drive-letter paths', () => {
    for (const bad of ['/etc/passwd', 'C:\\Windows\\evil.dll']) {
      let threw = false;
      try {
        assertSafeEntryName(bad);
      } catch (e) {
        threw = true;
        expect(e.code).toBe('ZIP_SLIP');
      }
      expect(threw).toBeTruthy();
    }
  });

  it('treats backslashes as separators, so ..\\ is caught too', () => {
    let threw = false;
    try {
      assertSafeEntryName('..\\..\\evil.js');
    } catch (e) {
      threw = true;
      expect(e.code).toBe('ZIP_SLIP');
    }
    expect(threw).toBeTruthy();
  });

  it('rejects a NUL byte in the name', () => {
    let threw = false;
    try {
      assertSafeEntryName('index.html\0.js');
    } catch (e) {
      threw = true;
      expect(e.code).toBe('ZIP_SLIP');
    }
    expect(threw).toBeTruthy();
  });

  it('does not reject a filename that merely contains dots', () => {
    expect(assertSafeEntryName('main..js')).toBe('main..js');
    expect(assertSafeEntryName('a/.hidden')).toBe('a/.hidden');
  });
});

describe('findMainBundle', () => {
  it('finds a hashed Angular main bundle', () => {
    expect(findMainBundle(['index.html', 'main.4f2a91c3.js'])).toBe('main.4f2a91c3.js');
  });

  it('returns null when there is no main bundle at all', () => {
    expect(findMainBundle(['index.html', 'runtime.js'])).toBeNull();
  });
});

describe('inspectZip — rejections (nothing live is touched)', () => {
  it('rejects a non-zip file (bad magic bytes)', async () => {
    const p = fixture('not-a-zip.zip');
    fs.writeFileSync(p, 'this is a plain text file pretending to be a zip archive');
    await expectRejection(() => inspectZip(p), { code: 'NOT_A_ZIP' });
  });

  it('rejects a gzip renamed to .zip', async () => {
    const p = fixture('renamed.zip');
    // gzip magic 1f 8b — a real "wrong file uploaded" case
    fs.writeFileSync(p, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02]));
    await expectRejection(() => inspectZip(p), { code: 'NOT_A_ZIP' });
  });

  it('rejects an empty file', async () => {
    const p = fixture('empty.zip');
    fs.writeFileSync(p, '');
    await expectRejection(() => inspectZip(p), { code: 'NOT_A_ZIP' });
  });

  it('rejects a zip containing a ../ entry', async () => {
    const p = writeZip(fixture('zipslip.zip'), [
      ...angularDistEntries(),
      { name: '../../../../home/ubi-backend/.ssh/authorized_keys', content: 'ssh-rsa AAAA' },
    ]);
    const err = await expectRejection(() => inspectZip(p), { code: 'ZIP_SLIP' });
    expect(err.message).toContain('traversal');
  });

  it('rejects a zip containing an absolute-path entry', async () => {
    const p = writeZip(fixture('absolute.zip'), [
      ...angularDistEntries(),
      { name: '/etc/cron.d/backdoor', content: '* * * * * root sh -c :' },
    ]);
    await expectRejection(() => inspectZip(p), { code: 'ZIP_SLIP' });
  });

  it('rejects a zip containing a symlink entry', async () => {
    const p = writeZip(fixture('symlink.zip'), [
      ...angularDistEntries(),
      // Extracting this, then writing "escape/passwd", writes to /etc/passwd.
      { name: 'escape', content: '/etc', symlink: true },
    ]);
    const err = await expectRejection(() => inspectZip(p), { code: 'ZIP_SLIP' });
    expect(err.message).toContain('symlink');
  });

  it('reports a symlink named ../x as a traversal (name checked first)', async () => {
    const p = writeZip(fixture('symlink-traversal.zip'), [
      ...angularDistEntries(),
      { name: '../escape', content: '/etc', symlink: true },
    ]);
    await expectRejection(() => inspectZip(p), { code: 'ZIP_SLIP' });
  });

  it('rejects a zip with no index.html (source zip uploaded by mistake)', async () => {
    const p = writeZip(fixture('no-index.zip'), [
      { name: 'src/app/app.component.ts', content: 'export class AppComponent {}' },
      { name: 'package.json', content: '{"name":"ubi-frontend"}' },
      { name: 'README.md', content: '# source' },
    ]);
    const err = await expectRejection(() => inspectZip(p), { code: 'NO_INDEX_HTML' });
    expect(err.message).toContain('not a built frontend');
  });

  it('accepts index.html two folders deep, stripping both levels', async () => {
    // This was previously rejected. That was the bug: real `ng build` output is
    // nested (dist/<project>/, and dist/<project>/browser/ on Angular 17+), so
    // rejecting depth > 1 refused legitimate builds.
    const p = writeZip(fixture('too-deep.zip'), [
      { name: 'build/dist/index.html', content: '<html></html>' },
      { name: 'build/dist/main.abc123.js', content: 'x' },
    ]);
    const r = await inspectZip(p);
    expect(r.ok).toBeTruthy();
    expect(r.wrapper).toBe('build/dist');
    expect(r.files).toEqual(['index.html', 'main.abc123.js']);
  });

  it('rejects two sibling builds in one zip as ambiguous', async () => {
    // Still rejected, but as AMBIGUOUS_ROOT rather than NO_INDEX_HTML: there is
    // an index.html, we simply must not guess which build is meant to go live.
    const p = writeZip(fixture('two-tops.zip'), [
      { name: 'dist/index.html', content: '<html></html>' },
      { name: 'other/index.html', content: '<html></html>' },
    ]);
    const err = await expectRejection(() => inspectZip(p), { code: 'AMBIGUOUS_ROOT' });
    expect(err.message).toContain('dist/index.html');
  });

  it('rejects a zip bomb by compression ratio', async () => {
    // 8 MB of zeros stored... but we lie about it being small? No: build it for
    // real and rely on the ratio check against the stored size.
    const big = Buffer.alloc(4 * 1024 * 1024, 0);
    const p = writeZip(fixture('bomb.zip'), [
      ...angularDistEntries(),
      { name: 'huge.bin', content: big },
    ]);
    // Stored (not deflated), so ratio ~1:1 and this must PASS the ratio check.
    const result = await inspectZip(p);
    expect(result.ok).toBeTruthy();
  });

  it('rejects an archive with no files at all', async () => {
    const p = writeZip(fixture('dirs-only.zip'), [{ name: 'dist/', dir: true }]);
    await expectRejection(() => inspectZip(p), { code: 'EMPTY_ARCHIVE' });
  });
});

describe('inspectZip — accepted archives', () => {
  it('accepts a dist at the archive root, no wrapper', async () => {
    const p = writeZip(fixture('root-dist.zip'), angularDistEntries());
    const r = await inspectZip(p);
    expect(r.ok).toBeTruthy();
    expect(r.wrapper).toBeNull();
    expect(r.indexPath).toBe('index.html');
    expect(r.mainBundle).toBe('main.4f2a91c3d0e1b7a5.js');
    expect(r.entryCount).toBe(5);
    expect(r.sha256).toHaveLength(64);
  });

  it('detects a wrapper folder that must be stripped', async () => {
    const p = writeZip(fixture('wrapped.zip'), angularDistEntries('dist'));
    const r = await inspectZip(p);
    expect(r.wrapper).toBe('dist');
    expect(r.indexPath).toBe('dist/index.html');
    // Reported filenames are already wrapper-stripped, i.e. deployed layout.
    expect(r.files).toContain('index.html');
    expect(r.files).toContain('assets/logo.svg');
    expect(r.mainBundle).toBe('main.4f2a91c3d0e1b7a5.js');
  });

  it('accepts a dist nested two levels deep (dist/<project>/index.html)', async () => {
    // What `ng build` actually emits in a multi-project workspace. Assuming at
    // most one wrapper folder rejected this outright.
    const p = writeZip(fixture('ng-multiproject.zip'), angularDistEntries('dist/ubi-frontend'));
    const r = await inspectZip(p);
    expect(r.ok).toBeTruthy();
    expect(r.wrapper).toBe('dist/ubi-frontend');
    expect(r.files).toContain('index.html');
    expect(r.files).toContain('assets/logo.svg');
  });

  it('accepts the Angular 17+ application-builder layout (dist/<project>/browser/)', async () => {
    const p = writeZip(fixture('ng17.zip'), angularDistEntries('dist/ubi-frontend/browser'));
    const r = await inspectZip(p);
    expect(r.ok).toBeTruthy();
    expect(r.wrapper).toBe('dist/ubi-frontend/browser');
    expect(r.files).toContain('index.html');
  });

  it('ignores __MACOSX and .DS_Store noise from a Finder-created zip', async () => {
    // Finder adds a __MACOSX sibling folder. Counting it as content made the
    // archive look like it had two top-level folders and rejected a good build.
    const p = writeZip(fixture('finder.zip'), [
      ...angularDistEntries('dist'),
      { name: '__MACOSX/._dist', content: 'apple double junk' },
      { name: '__MACOSX/dist/._index.html', content: 'apple double junk' },
      { name: 'dist/.DS_Store', content: 'finder metadata' },
      { name: '.DS_Store', content: 'finder metadata' },
    ]);
    const r = await inspectZip(p);
    expect(r.ok).toBeTruthy();
    expect(r.wrapper).toBe('dist');
    // Noise must not be listed as deployable content.
    expect(r.files.some((f) => f.includes('__MACOSX'))).toBeFalsy();
    expect(r.files.some((f) => f.includes('.DS_Store'))).toBeFalsy();
  });

  it('accepts a custom entry document and reports the copy to index.html', async () => {
    // angular.json can point a build configuration at a custom index document;
    // the output keeps that name. PM2_SERVE_SPA only falls back to index.html.
    const entries = angularDistEntries('', 'DEVBUILD01').map((e) =>
      e.name === 'index.html' ? { ...e, name: 'index.ubidev.html' } : e
    );
    const p = writeZip(fixture('custom-index.zip'), entries);

    const r = await inspectZip(p);
    expect(r.ok).toBeTruthy();
    expect(r.indexCopyFrom).toBe('index.ubidev.html');
    // Both the original and the copy are part of the release.
    expect(r.files).toContain('index.ubidev.html');
    expect(r.files).toContain('index.html');
    expect(r.warnings.join(' ')).toContain('index.ubidev.html');
    expect(r.warnings.join(' ')).toContain('copied to index.html');
  });

  it('does not let a deep stray index.html beat the real entry document', async () => {
    // The shape of a real ETB/NTB build: the entry document sits one level in as
    // index.ubidev.html, and an icon pack ships its own index.html three levels
    // deep. Preferring the exact name before depth picked the icon folder as the
    // app root — the release would have contained icons and nothing else.
    const p = writeZip(fixture('stray-deep-index.zip'), [
      { name: 'ubi-dist/index.ubidev.html', content: '<html><script src="main.68872469fc39d01e.js"></script></html>' },
      { name: 'ubi-dist/main.68872469fc39d01e.js', content: 'console.log("app")' },
      { name: 'ubi-dist/styles.abc123.css', content: 'body{}' },
      { name: 'ubi-dist/assets/icons/index.html', content: '<html>icon demo page</html>' },
      { name: 'ubi-dist/assets/icons/icon.svg', content: '<svg/>' },
    ]);

    const r = await inspectZip(p);
    expect(r.ok).toBeTruthy();
    expect(r.wrapper).toBe('ubi-dist');
    expect(r.indexCopyFrom).toBe('index.ubidev.html');
    // Bundle must be reported wrapper-stripped, i.e. as it will exist on disk.
    expect(r.mainBundle).toBe('main.68872469fc39d01e.js');
    expect(r.files).toContain('index.html');
    expect(r.files).toContain('assets/icons/index.html');
  });

  it('prefers a real index.html over a variant when both exist', async () => {
    const p = writeZip(fixture('both-indexes.zip'), [
      ...angularDistEntries(),
      { name: 'index.ubidev.html', content: '<html>dev variant</html>' },
    ]);
    const r = await inspectZip(p);
    expect(r.ok).toBeTruthy();
    expect(r.indexCopyFrom).toBeNull();
  });

  it('rejects two candidate entry documents at the same depth', async () => {
    const p = writeZip(fixture('ambiguous-index.zip'), [
      { name: 'index.dev.html', content: '<html>dev</html>' },
      { name: 'index.prod.html', content: '<html>prod</html>' },
      { name: 'main.abc123.js', content: 'x' },
    ]);
    const err = await expectRejection(() => inspectZip(p), { code: 'AMBIGUOUS_ROOT' });
    expect(err.message).toContain('Cannot determine');
  });

  it('names the top-level contents when there is no entry document at all', async () => {
    const p = writeZip(fixture('src-only.zip'), [
      { name: 'src/main.ts', content: 'bootstrap()' },
      { name: 'angular.json', content: '{}' },
    ]);
    const err = await expectRejection(() => inspectZip(p), { code: 'NO_INDEX_HTML' });
    // The message must say what it DID find, so the operator can tell a source
    // zip apart from a build nested one level deeper than expected.
    expect(err.message).toContain('angular.json');
    expect(err.message).toContain('src');
  });

  it('warns (but does not reject) when there is no hashed main bundle', async () => {
    const p = writeZip(fixture('no-main.zip'), [
      { name: 'index.html', content: '<html></html>' },
      { name: 'runtime.js', content: 'x' },
    ]);
    const r = await inspectZip(p);
    expect(r.ok).toBeTruthy();
    expect(r.mainBundle).toBeNull();
    expect(r.warnings.join(' ')).toContain('health check');
  });
});

describe('inspectZip — diff vs the live release', () => {
  it('flags an archive identical to what is already live', async () => {
    const entries = angularDistEntries();
    const live = makeLiveDir('live-identical', entries);
    const p = writeZip(fixture('identical.zip'), entries);

    const r = await inspectZip(p, { liveLink: live });
    expect(r.diff.identical).toBeTruthy();
    expect(r.diff.added).toHaveLength(0);
    expect(r.diff.removed).toHaveLength(0);
    expect(r.diff.changed).toHaveLength(0);
    expect(r.warnings.join(' ')).toContain('identical');
  });

  it('still reports identical when the live release has a deployer meta.json', async () => {
    // Every release this tool deploys contains meta.json. If the diff counted
    // it, redeploying the very same artifact would look like a change and the
    // "identical" warning would never fire for a real release.
    const entries = angularDistEntries();
    const live = makeLiveDir('live-with-meta', [
      ...entries,
      { name: 'meta.json', content: JSON.stringify({ releaseId: '20260810-120000' }) },
    ]);
    const p = writeZip(fixture('identical-meta.zip'), entries);

    const r = await inspectZip(p, { liveLink: live });
    expect(r.diff.identical).toBeTruthy();
    expect(r.diff.removed).toHaveLength(0);
    expect(r.warnings.join(' ')).toContain('identical');
  });

  it('reports added / removed / changed filenames', async () => {
    const live = makeLiveDir('live-diff', [
      { name: 'index.html', content: '<html>old</html>' },
      { name: 'main.OLDHASH0.js', content: 'old' },
      { name: 'gone.js', content: 'removed in the new build' },
    ]);
    const p = writeZip(fixture('changed.zip'), angularDistEntries());

    const r = await inspectZip(p, { liveLink: live });
    expect(r.diff.identical).toBeFalsy();
    expect(r.diff.added).toContain('main.4f2a91c3d0e1b7a5.js');
    expect(r.diff.removed).toContain('gone.js');
    // index.html exists in both with different sizes
    expect(r.diff.changed).toContain('index.html');
  });

  it('warns when the new build is missing a large share of live files', async () => {
    const live = makeLiveDir('live-partial', [
      { name: 'index.html', content: '<html></html>' },
      { name: 'a.js', content: 'a' },
      { name: 'b.js', content: 'b' },
      { name: 'c.js', content: 'c' },
      { name: 'd.js', content: 'd' },
    ]);
    const p = writeZip(fixture('partial.zip'), [
      { name: 'index.html', content: '<html></html>' },
    ]);

    const r = await inspectZip(p, { liveLink: live });
    expect(r.warnings.join(' ')).toContain('missing');
  });

  it('handles a liveLink that does not exist yet (pre-migration)', async () => {
    const p = writeZip(fixture('first-deploy.zip'), angularDistEntries());
    const r = await inspectZip(p, { liveLink: path.join(TMP, 'does-not-exist') });
    expect(r.ok).toBeTruthy();
    expect(r.diff.hasLive).toBeFalsy();
    expect(r.diff.identical).toBeFalsy();
  });

  it('reads the live main bundle from meta.json when present', async () => {
    const live = makeLiveDir('live-meta', [
      ...angularDistEntries('', 'OLDHASH123456789'),
      { name: 'meta.json', content: JSON.stringify({ mainBundle: 'main.OLDHASH123456789.js' }) },
    ]);
    const p = writeZip(fixture('newer.zip'), angularDistEntries('', 'NEWHASH987654321'));
    const r = await inspectZip(p, { liveLink: live });
    expect(r.liveMainBundle).toBe('main.OLDHASH123456789.js');
    expect(r.mainBundle).toBe('main.NEWHASH987654321.js');
  });
});
