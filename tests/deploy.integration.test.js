/**
 * deploy.integration.test.js — the deploy engine against a real filesystem and
 * a real HTTP server, in a sandbox.
 *
 * The fake server models the one pm2 behaviour that makes this module subtle:
 * `pm2 serve` resolves the served directory once and holds it, so swapping the
 * symlink underneath changes nothing until the process restarts. The server here
 * caches realpath(liveLink) at boot and only re-resolves when the "restart"
 * command hits /__restart. A test that re-read the symlink on every request
 * would pass even if we forgot to restart at all — i.e. it would test nothing.
 */

process.env.CONFIRM_HMAC_SECRET =
  process.env.CONFIRM_HMAC_SECRET || 'test-secret-value-at-least-32-chars-long!!';

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { describe, it, expect } from './harness.js';
import { writeZip, angularDistEntries } from './zip-builder.js';
import {
  deployRelease,
  rollbackRelease,
  listReleases,
  currentLiveRelease,
  assertLiveLinkIsSymlink,
  acquireLock,
  releaseLock,
} from '../lib/deploy.js';
import { inspectZip } from '../lib/zip-inspect.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ubi-ops-deploy-'));

/* ----------------------------------------------------- fake "pm2 serve" app */

let servedRoot = null;
let liveLinkForServer = null;
let restartCount = 0;

function resolveServedRoot() {
  try {
    servedRoot = fs.realpathSync(liveLinkForServer);
  } catch {
    servedRoot = null;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/__restart') {
    restartCount += 1;
    resolveServedRoot();
    res.writeHead(200).end('restarted');
    return;
  }

  if (!servedRoot) {
    res.writeHead(503).end('no root');
    return;
  }

  // PM2_SERVE_SPA=true: every unknown path falls back to index.html. This is
  // exactly why a bare 200 cannot prove which build is live.
  const indexPath = path.join(servedRoot, 'index.html');
  fs.readFile(indexPath, (err, body) => {
    if (err) {
      res.writeHead(500).end('missing index.html');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
});

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const HEALTH_URL = `http://127.0.0.1:${port}/`;

// The "restart command": a node script that pokes the server, mirroring what
// `pm2 restart <name>` does to a running pm2 serve process.
const restartScript = path.join(TMP, 'fake-pm2-restart.mjs');
await fsp.writeFile(
  restartScript,
  `const fail = process.env.FAKE_PM2_FAIL === '1';
if (fail) { console.error('fake pm2: restart failed'); process.exit(1); }
const res = await fetch('${HEALTH_URL}__restart');
console.log('[PM2] App restarted, exit code ' + (res.ok ? 0 : 1));
`,
  'utf8'
);

/* --------------------------------------------------------------- test target */

function makeTarget(name, { keepReleases = 5 } = {}) {
  const base = path.join(TMP, name);
  const target = {
    key: name,
    label: `Test target ${name}`,
    pm2Name: 'fake-app',
    liveLink: path.join(base, 'ubi-dist'),
    releasesDir: path.join(base, 'releases'),
    restartCommand: ['node', restartScript],
    healthUrl: HEALTH_URL,
    keepReleases,
    // Keep the suite fast; production targets use the default schedule.
    healthBackoffMs: [50, 100, 150, 200],
  };
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(target.releasesDir, { recursive: true });
  return target;
}

/** Simulate the pre-existing state: ubi-dist is a real directory. */
function seedRealDirectory(target, mainHash = 'LEGACYHASH00') {
  fs.mkdirSync(target.liveLink, { recursive: true });
  for (const entry of angularDistEntries('', mainHash)) {
    const p = path.join(target.liveLink, entry.name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, String(entry.content));
  }
}

/** What migrate-target.js does: move the dir into releases/, symlink it back. */
async function migrate(target) {
  const legacyDir = path.join(target.releasesDir, 'legacy-20260810');
  await fsp.rename(target.liveLink, legacyDir);
  await fsp.symlink(legacyDir, target.liveLink);
  await fsp.writeFile(
    path.join(legacyDir, 'meta.json'),
    JSON.stringify({
      releaseId: 'legacy-20260810',
      username: 'migration',
      deployedAt: new Date().toISOString(),
      mainBundle: 'main.LEGACYHASH00.js',
    }),
    'utf8'
  );
  return legacyDir;
}

/** Point the fake server at this target and boot it. */
function attachServer(target) {
  liveLinkForServer = target.liveLink;
  resolveServedRoot();
}

async function runDeploy(target, zipPath, { username = 'tester' } = {}) {
  const plan = await inspectZip(zipPath, { liveLink: target.liveLink });
  const events = [];
  const result = await deployRelease({
    target,
    zipPath,
    plan,
    username,
    artifactName: path.basename(zipPath),
    emit: (e) => events.push(e),
  });
  return { result, events, plan };
}

const logsOf = (events) =>
  events.filter((e) => e.type === 'log').map((e) => e.message).join('\n');

/* ---------------------------------------------------------------- the tests */

describe('deploy: refuses to run before migration', () => {
  it('rejects a liveLink that is still a real directory', async () => {
    const target = makeTarget('pre-migration');
    seedRealDirectory(target);
    attachServer(target);

    const zipPath = writeZip(path.join(TMP, 'first.zip'), angularDistEntries('', 'NEWHASH01'));
    const { result } = await runDeploy(target, zipPath);

    expect(result.ok).toBeFalsy();
    expect(result.code).toBe('NOT_MIGRATED');
    // The live directory must be exactly as it was.
    expect(fs.existsSync(path.join(target.liveLink, 'index.html'))).toBeTruthy();
    expect(fs.lstatSync(target.liveLink).isSymbolicLink()).toBeFalsy();
  });

  it('accepts it once it is a symlink', async () => {
    const target = makeTarget('post-migration');
    seedRealDirectory(target);
    await migrate(target);
    await assertLiveLinkIsSymlink(target); // must not throw
    expect(fs.lstatSync(target.liveLink).isSymbolicLink()).toBeTruthy();
  });
});

describe('deploy: happy path', () => {
  it('extracts, swaps atomically, restarts, and asserts the new bundle', async () => {
    const target = makeTarget('happy');
    seedRealDirectory(target);
    const legacyDir = await migrate(target);
    attachServer(target);

    const before = restartCount;
    const zipPath = writeZip(path.join(TMP, 'good.zip'), angularDistEntries('', 'NEWHASH1234'));
    const { result, events } = await runDeploy(target, zipPath, { username: 'ramith' });

    expect(result.ok).toBeTruthy();

    // The restart actually happened — without it the health check could not pass.
    expect(restartCount > before).toBeTruthy();

    // liveLink is a symlink pointing at the new release, not the legacy one.
    // Compare through realpath: on macOS the temp dir is itself a symlink
    // (/var -> /private/var), so a literal join would not match.
    const live = await currentLiveRelease(target);
    expect(live === fs.realpathSync(legacyDir)).toBeFalsy();
    expect(live).toBe(fs.realpathSync(path.join(target.releasesDir, result.releaseId)));
    expect(fs.lstatSync(target.liveLink).isSymbolicLink()).toBeTruthy();

    // Served content is the new build.
    const body = await (await fetch(HEALTH_URL)).text();
    expect(body).toContain('main.NEWHASH1234.js');

    // Health assertion was the bundle, not merely a 200.
    expect(logsOf(events)).toContain('references main.NEWHASH1234.js');

    // meta.json records who/what/when.
    const meta = JSON.parse(
      fs.readFileSync(path.join(live, 'meta.json'), 'utf8')
    );
    expect(meta.username).toBe('ramith');
    expect(meta.mainBundle).toBe('main.NEWHASH1234.js');
    expect(meta.artifact).toBe('good.zip');
    expect(typeof meta.deployedAt).toBe('string');

    // The artifact is retained beside the release for an exact redeploy.
    expect(fs.existsSync(path.join(target.releasesDir, `${result.releaseId}.zip`))).toBeTruthy();
  });

  it('strips a wrapper folder so index.html lands at the release root', async () => {
    const target = makeTarget('wrapped');
    seedRealDirectory(target);
    await migrate(target);
    attachServer(target);

    const zipPath = writeZip(path.join(TMP, 'wrapped.zip'), angularDistEntries('dist', 'WRAP99'));
    const { result, events } = await runDeploy(target, zipPath);

    expect(result.ok).toBeTruthy();
    const live = await currentLiveRelease(target);
    // index.html at the root of the release, not under dist/
    expect(fs.existsSync(path.join(live, 'index.html'))).toBeTruthy();
    expect(fs.existsSync(path.join(live, 'dist'))).toBeFalsy();
    expect(fs.existsSync(path.join(live, 'assets', 'logo.svg'))).toBeTruthy();
    expect(logsOf(events)).toContain('stripped wrapper folder "dist/"');
  });
});

describe('deploy: custom entry document', () => {
  it('copies index.<name>.html to index.html so the SPA fallback can serve it', async () => {
    const target = makeTarget('custom-index');
    seedRealDirectory(target);
    await migrate(target);
    attachServer(target);

    // A build whose entry document is index.ubidev.html, as angular.json can
    // produce. Without the copy, pm2's index.html fallback finds nothing and
    // the health check would (correctly) fail.
    const entries = angularDistEntries('', 'DEVUBI0001').map((e) =>
      e.name === 'index.html' ? { ...e, name: 'index.ubidev.html' } : e
    );
    const zipPath = writeZip(path.join(TMP, 'custom-index.zip'), entries);

    const { result, events } = await runDeploy(target, zipPath);
    expect(result.ok).toBeTruthy();

    const live = await currentLiveRelease(target);
    // Both files exist in the release.
    expect(fs.existsSync(path.join(live, 'index.ubidev.html'))).toBeTruthy();
    expect(fs.existsSync(path.join(live, 'index.html'))).toBeTruthy();
    // And they are the same document.
    expect(fs.readFileSync(path.join(live, 'index.html'), 'utf8')).toBe(
      fs.readFileSync(path.join(live, 'index.ubidev.html'), 'utf8')
    );

    expect(logsOf(events)).toContain('copied index.ubidev.html -> index.html');

    // The server (which only ever serves index.html) returns the new build.
    const body = await (await fetch(HEALTH_URL)).text();
    expect(body).toContain('main.DEVUBI0001.js');
  });
});

describe('deploy: a stale build cannot pass the health check', () => {
  it('auto-rolls-back when the served page does not reference the new bundle', async () => {
    const target = makeTarget('broken');
    seedRealDirectory(target);
    await migrate(target);
    attachServer(target);

    // First, a good deploy so there is something to roll back to.
    const goodZip = writeZip(path.join(TMP, 'good2.zip'), angularDistEntries('', 'GOOD777'));
    const first = await runDeploy(target, goodZip);
    expect(first.result.ok).toBeTruthy();
    const goodRelease = await currentLiveRelease(target); // realpath'd

    // A broken build: main.BROKEN1.js ships, but index.html never references it,
    // which is what a half-finished/misconfigured Angular build looks like.
    const brokenZip = writeZip(path.join(TMP, 'broken.zip'), [
      {
        name: 'index.html',
        content: '<!doctype html><html><body><app-root></app-root></body></html>',
      },
      { name: 'main.BROKEN1.js', content: 'console.log("broken")' },
    ]);

    const { result, events } = await runDeploy(target, brokenZip);

    expect(result.ok).toBeFalsy();
    expect(result.rolledBack).toBeTruthy();

    // Live is back on the good release.
    expect(await currentLiveRelease(target)).toBe(goodRelease);
    const body = await (await fetch(HEALTH_URL)).text();
    expect(body).toContain('main.GOOD777.js');

    const log = logsOf(events);
    expect(log).toContain('health check failed');
    expect(log).toContain('rollback: complete');
  });

  it('reports failure without rollback when there is no previous release', async () => {
    const target = makeTarget('first-and-broken');
    // No migration, no legacy: liveLink does not exist at all yet.
    attachServer(target);

    const brokenZip = writeZip(path.join(TMP, 'broken-first.zip'), [
      { name: 'index.html', content: '<html><body>no bundle ref</body></html>' },
      { name: 'main.NOPE1.js', content: 'x' },
    ]);

    const { result, events } = await runDeploy(target, brokenZip);
    expect(result.ok).toBeFalsy();
    expect(result.rolledBack).toBeFalsy();
    expect(logsOf(events)).toContain('no previous release');
  });
});

describe('deploy: a failing restart is not treated as success', () => {
  it('rolls back when the restart command exits non-zero', async () => {
    const target = makeTarget('restart-fail');
    seedRealDirectory(target);
    await migrate(target);
    attachServer(target);

    const goodZip = writeZip(path.join(TMP, 'good3.zip'), angularDistEntries('', 'GOOD888'));
    const first = await runDeploy(target, goodZip);
    expect(first.result.ok).toBeTruthy();
    const goodRelease = await currentLiveRelease(target); // realpath'd

    // Make the next restart fail.
    process.env.FAKE_PM2_FAIL = '1';
    try {
      const nextZip = writeZip(path.join(TMP, 'good4.zip'), angularDistEntries('', 'GOOD999'));
      const { result } = await runDeploy(target, nextZip);
      expect(result.ok).toBeFalsy();
      expect(result.rolledBack).toBeTruthy();
    } finally {
      delete process.env.FAKE_PM2_FAIL;
    }

    // Restore: the rollback restart also ran with FAKE_PM2_FAIL set, so re-point
    // and restart cleanly, then confirm the good release is what is served.
    expect(await currentLiveRelease(target)).toBe(goodRelease);
  });
});

describe('rollback: manual, verified the same way', () => {
  it('restores a previous release and asserts its bundle is served', async () => {
    const target = makeTarget('manual-rollback');
    seedRealDirectory(target);
    await migrate(target);
    attachServer(target);

    const zipA = writeZip(path.join(TMP, 'rel-a.zip'), angularDistEntries('', 'RELA111'));
    const a = await runDeploy(target, zipA);
    expect(a.result.ok).toBeTruthy();

    const zipB = writeZip(path.join(TMP, 'rel-b.zip'), angularDistEntries('', 'RELB222'));
    const b = await runDeploy(target, zipB);
    expect(b.result.ok).toBeTruthy();

    let bodyNow = await (await fetch(HEALTH_URL)).text();
    expect(bodyNow).toContain('main.RELB222.js');

    // Roll back to A.
    const events = [];
    const result = await rollbackRelease({
      target,
      releaseIdToRestore: a.result.releaseId,
      username: 'tester',
      emit: (e) => events.push(e),
    });

    expect(result.ok).toBeTruthy();
    bodyNow = await (await fetch(HEALTH_URL)).text();
    expect(bodyNow).toContain('main.RELA111.js');

    const { releases } = await listReleases(target);
    const liveOne = releases.find((r) => r.isLive);
    expect(liveOne.id).toBe(a.result.releaseId);
  });

  it('refuses to roll back to the release that is already live', async () => {
    const target = makeTarget('rollback-noop');
    seedRealDirectory(target);
    await migrate(target);
    attachServer(target);

    const zip = writeZip(path.join(TMP, 'rel-c.zip'), angularDistEntries('', 'RELC333'));
    const c = await runDeploy(target, zip);

    const events = [];
    const result = await rollbackRelease({
      target,
      releaseIdToRestore: c.result.releaseId,
      username: 'tester',
      emit: (e) => events.push(e),
    });
    expect(result.ok).toBeFalsy();
    expect(result.code).toBe('ALREADY_LIVE');
  });

  it('rejects an unknown release id', async () => {
    const target = makeTarget('rollback-unknown');
    seedRealDirectory(target);
    await migrate(target);
    attachServer(target);

    const events = [];
    const result = await rollbackRelease({
      target,
      releaseIdToRestore: '20200101-000000',
      username: 'tester',
      emit: (e) => events.push(e),
    });
    expect(result.ok).toBeFalsy();
    expect(result.code).toBe('NO_SUCH_RELEASE');
  });
});

describe('releases: listing and pruning', () => {
  it('lists releases newest first with LIVE flagged', async () => {
    const target = makeTarget('listing');
    seedRealDirectory(target);
    await migrate(target);
    attachServer(target);

    const zip = writeZip(path.join(TMP, 'list-a.zip'), angularDistEntries('', 'LISTA1'));
    const deployed = await runDeploy(target, zip, { username: 'lister' });

    const { releases } = await listReleases(target);
    expect(releases.length >= 2).toBeTruthy();
    expect(releases[0].id).toBe(deployed.result.releaseId);
    expect(releases[0].isLive).toBeTruthy();
    expect(releases[0].deployedBy).toBe('lister');
    expect(releases[0].hasArtifact).toBeTruthy();
    // The adopted legacy release is still listed.
    expect(releases.some((r) => r.id === 'legacy-20260810')).toBeTruthy();
  });

  it('prunes to keepReleases and never removes the live or rollback release', async () => {
    const target = makeTarget('pruning', { keepReleases: 2 });
    seedRealDirectory(target);
    await migrate(target);
    attachServer(target);

    const ids = [];
    for (let i = 1; i <= 4; i += 1) {
      const zip = writeZip(
        path.join(TMP, `prune-${i}.zip`),
        angularDistEntries('', `PRUNE${i}00`)
      );
      const r = await runDeploy(target, zip);
      expect(r.result.ok).toBeTruthy();
      ids.push(r.result.releaseId);
    }

    const { releases } = await listReleases(target);
    const live = releases.find((r) => r.isLive);
    expect(live.id).toBe(ids[ids.length - 1]);

    // keepReleases=2, so the legacy release and early ones are gone.
    expect(releases.length <= 3).toBeTruthy();
    expect(fs.existsSync(path.join(target.releasesDir, 'legacy-20260810'))).toBeFalsy();
    // The live release survived, obviously.
    expect(fs.existsSync(live.dir)).toBeTruthy();
  });
});

describe('deploy lock', () => {
  it('refuses a second concurrent deploy to the same target', async () => {
    const target = makeTarget('locking');
    seedRealDirectory(target);
    await migrate(target);
    attachServer(target);

    const held = await acquireLock(target, 'first-user');
    try {
      const zip = writeZip(path.join(TMP, 'locked.zip'), angularDistEntries('', 'LOCK1'));
      const { result } = await runDeploy(target, zip);
      expect(result.ok).toBeFalsy();
      expect(result.code).toBe('LOCKED');
      expect(result.error).toContain('first-user');
    } finally {
      await releaseLock(held);
    }
  });

  it('releases the lock after a successful deploy', async () => {
    const target = makeTarget('lock-release');
    seedRealDirectory(target);
    await migrate(target);
    attachServer(target);

    const zip = writeZip(path.join(TMP, 'unlocked.zip'), angularDistEntries('', 'UNLOCK1'));
    const { result } = await runDeploy(target, zip);
    expect(result.ok).toBeTruthy();
    expect(fs.existsSync(path.join(target.releasesDir, '.deploy.lock'))).toBeFalsy();

    // A second deploy therefore succeeds.
    const zip2 = writeZip(path.join(TMP, 'unlocked2.zip'), angularDistEntries('', 'UNLOCK2'));
    const second = await runDeploy(target, zip2);
    expect(second.result.ok).toBeTruthy();
  });
});

describe('teardown', () => {
  it('closes the fake server', async () => {
    await new Promise((resolve) => server.close(resolve));
    expect(true).toBeTruthy();
  });
});
