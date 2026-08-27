/**
 * bypass.test.js — the flag editor writes a real file and restarts a real
 * process, so both halves are tested against a real filesystem and a real child
 * process rather than mocks.
 *
 * The fake pm2 is the interesting part. It reads the config file it was pointed
 * at and reports `errored` when the file contains BROKEN:true — which is what a
 * bad bypass.json actually does to the backend: it throws at boot and pm2 keeps
 * retrying. A test double that always reports `online` would pass even if the
 * health gate and the auto-restore were deleted.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, expectRejection } from './harness.js';
import {
  applyBypassChanges,
  applyChanges,
  classifyValue,
  describeKeys,
  detectIndent,
  diffConfigs,
  enablingChanges,
  listBackups,
  listBypassTargets,
  planChanges,
  pm2Snapshot,
  readAudit,
  readConfig,
  restoreBypassBackup,
  serializeConfig,
  sha256,
} from '../lib/bypass.js';

/* ------------------------------------------------------------------ fixtures */

/** The real file from the instance, trimmed to the shapes that matter. */
const SAMPLE = {
  BYPASS: true,
  USER_OTP_BYPASS: true,
  V1_ENCRYPTION_BYPASS: false,
  MOBILE_BYPASS: true,
  BROKEN: false,
  RETRY_LIMIT: 3,
  MOCK_MODE: 'uat',
  LAND_BRE_STATUS_BYPASS: ['bre_status', 'land_bre_status'],
  NESTED: { a: 1 },
};

const FAKE_PM2 = (configPath, statePath) => `
const fs = require('node:fs');
const verb = process.argv[2];
const readState = () => {
  try { return JSON.parse(fs.readFileSync(${JSON.stringify(statePath)}, 'utf8')); }
  catch { return { restarts: 0 }; }
};
const writeState = (s) => fs.writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(s));

if (verb === 'restart') {
  const state = readState();
  if (state.failRestart) {
    process.stderr.write('[PM2][ERROR] Process not found\\n');
    process.exit(1);
  }
  state.restarts = (state.restarts || 0) + 1;
  writeState(state);
  process.stdout.write('[PM2] restarted\\n');
  process.exit(0);
}

if (verb === 'jlist') {
  const state = readState();
  // The config file decides whether the app is up: a config the app cannot
  // accept means a process that never stays online.
  let healthy = true;
  try {
    const config = JSON.parse(fs.readFileSync(${JSON.stringify(configPath)}, 'utf8'));
    healthy = config.BROKEN !== true;
  } catch { healthy = false; }
  process.stdout.write(JSON.stringify([{
    name: 'test-backend',
    pm_id: 0,
    pid: healthy ? 4242 : 0,
    pm2_env: {
      status: healthy ? 'online' : 'errored',
      restart_time: state.restarts || 0,
      unstable_restarts: healthy ? 0 : 7,
      pm_uptime: Date.now() - 5000,
    },
  }]));
  process.exit(0);
}

process.stderr.write('unsupported verb\\n');
process.exit(2);
`;

let scratchRoot = null;

/** A throwaway target: real paths, a real child process, fast health backoff. */
async function makeTarget(config = SAMPLE, { failRestart = false, keepBackups = 30 } = {}) {
  scratchRoot =
    scratchRoot || (await fsp.mkdtemp(path.join(os.tmpdir(), 'ubi-bypass-tests-')));
  const dir = await fsp.mkdtemp(path.join(scratchRoot, 'case-'));

  const configPath = path.join(dir, 'bypass.json');
  const statePath = path.join(dir, 'pm2-state.json');
  const pm2Path = path.join(dir, 'fake-pm2.cjs');

  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 4)}\n`, 'utf8');
  await fsp.writeFile(statePath, JSON.stringify({ restarts: 0, failRestart }), 'utf8');
  await fsp.writeFile(pm2Path, FAKE_PM2(configPath, statePath), 'utf8');

  return {
    key: 'test-backend',
    label: 'Test backend',
    pm2Name: 'test-backend',
    configPath,
    backupsDir: path.join(dir, '.bypass-backups'),
    restartCommand: [process.execPath, pm2Path, 'restart', 'test-backend'],
    statusCommand: [process.execPath, pm2Path, 'jlist'],
    healthUrl: null,
    keepBackups,
    healthBackoffMs: [10, 10, 10],
    _statePath: statePath,
    _dir: dir,
  };
}

const readState = (target) => JSON.parse(fs.readFileSync(target._statePath, 'utf8'));

/** Drive a flow and collect the streamed events. */
async function collect(fn) {
  const events = [];
  const result = await fn((event) => events.push(event));
  return {
    result,
    events,
    steps: Object.fromEntries(
      events.filter((e) => e.type === 'step').map((e) => [e.name, e.status])
    ),
    done: events.find((e) => e.type === 'done') || null,
    error: events.find((e) => e.type === 'error') || null,
    log: events
      .filter((e) => e.type === 'log')
      .map((e) => e.message)
      .join('\n'),
  };
}

// Audit writes must not land in the repo's data/ directory.
process.env.BYPASS_AUDIT_PATH = path.join(
  os.tmpdir(),
  `ubi-bypass-audit-${process.pid}.jsonl`
);

/* ------------------------------------------------------------------- typing */

describe('bypass: value typing', () => {
  it('classifies the shapes the real file contains', () => {
    expect(classifyValue(true)).toBe('boolean');
    expect(classifyValue(false)).toBe('boolean');
    expect(classifyValue(3)).toBe('number');
    expect(classifyValue('uat')).toBe('string');
    expect(classifyValue(['a', 'b'])).toBe('stringArray');
    expect(classifyValue([])).toBe('stringArray');
  });

  it('treats nested objects, null and mixed arrays as read-only', () => {
    expect(classifyValue({ a: 1 })).toBe('readonly');
    expect(classifyValue(null)).toBe('readonly');
    expect(classifyValue(['a', 2])).toBe('readonly');
  });

  it('describes keys in file order so the screen matches the file', () => {
    const keys = describeKeys(SAMPLE).map((k) => k.key);
    expect(keys[0]).toBe('BYPASS');
    expect(keys[1]).toBe('USER_OTP_BYPASS');
    expect(keys[keys.length - 1]).toBe('NESTED');
  });

  it('marks the nested key as not editable', () => {
    const nested = describeKeys(SAMPLE).find((k) => k.key === 'NESTED');
    expect(nested.editable).toBeFalsy();
  });
});

/* -------------------------------------------------------------- change plans */

describe('bypass: planning a change', () => {
  it('accepts a boolean flip', () => {
    const changes = planChanges(SAMPLE, { USER_OTP_BYPASS: false });
    expect(changes).toHaveLength(1);
    expect(changes[0].key).toBe('USER_OTP_BYPASS');
    expect(changes[0].from).toBe(true);
    expect(changes[0].to).toBe(false);
  });

  it('drops keys whose value already matches', () => {
    const changes = planChanges(SAMPLE, { BYPASS: true, MOBILE_BYPASS: false });
    expect(changes).toHaveLength(1);
    expect(changes[0].key).toBe('MOBILE_BYPASS');
  });

  it('refuses a change that would not change anything', () => {
    let error = null;
    try {
      planChanges(SAMPLE, { BYPASS: true });
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe('NO_CHANGES');
  });

  it('refuses a key that is not already in the file', () => {
    // The failure this prevents: a typo'd flag name is a flag nothing reads, so
    // the bypass silently does nothing.
    let error = null;
    try {
      planChanges(SAMPLE, { USER_OTP_BYPAS: true });
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe('UNKNOWN_KEY');
  });

  it('refuses to change a boolean into a list', () => {
    let error = null;
    try {
      planChanges(SAMPLE, { BYPASS: ['yes'] });
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe('TYPE_MISMATCH');
  });

  it('refuses to change a list into a boolean', () => {
    let error = null;
    try {
      planChanges(SAMPLE, { LAND_BRE_STATUS_BYPASS: true });
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe('TYPE_MISMATCH');
  });

  it('refuses a nested value', () => {
    let error = null;
    try {
      planChanges(SAMPLE, { NESTED: 'x' });
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe('READONLY_KEY');
  });

  it('accepts valid list entries', () => {
    const changes = planChanges(SAMPLE, {
      LAND_BRE_STATUS_BYPASS: ['bre_status', 'land_bre_status', 'extra_status'],
    });
    expect(changes[0].to).toEqual(['bre_status', 'land_bre_status', 'extra_status']);
  });

  it('rejects a list entry with punctuation that has no place in a field name', () => {
    let error = null;
    try {
      planChanges(SAMPLE, { LAND_BRE_STATUS_BYPASS: ['bre status; drop'] });
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe('VALUE_REJECTED');
  });

  it('rejects a duplicated list entry rather than silently collapsing it', () => {
    let error = null;
    try {
      planChanges(SAMPLE, { LAND_BRE_STATUS_BYPASS: ['bre_status', 'bre_status'] });
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe('VALUE_REJECTED');
  });

  it('coerces a numeric string for a numeric key', () => {
    const changes = planChanges(SAMPLE, { RETRY_LIMIT: '5' });
    expect(changes[0].to).toBe(5);
  });

  it('rejects a multi-line string value', () => {
    let error = null;
    try {
      planChanges(SAMPLE, { MOCK_MODE: 'uat\nprod' });
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe('VALUE_REJECTED');
  });

  it('rejects a patch that is not an object', () => {
    let error = null;
    try {
      planChanges(SAMPLE, [{ key: 'BYPASS', to: false }]);
    } catch (err) {
      error = err;
    }
    expect(error?.code).toBe('INVALID_CHANGES');
  });

  it('applies changes without disturbing key order', () => {
    const next = applyChanges(SAMPLE, planChanges(SAMPLE, { MOBILE_BYPASS: false }));
    expect(Object.keys(next)).toEqual(Object.keys(SAMPLE));
    expect(next.MOBILE_BYPASS).toBe(false);
    expect(next.BYPASS).toBe(true);
  });

  it('flags the changes that ENABLE a bypass', () => {
    const changes = planChanges(SAMPLE, {
      V1_ENCRYPTION_BYPASS: true,
      MOBILE_BYPASS: false,
      LAND_BRE_STATUS_BYPASS: ['bre_status', 'land_bre_status', 'more_status'],
    });
    const enabling = enablingChanges(changes).map((c) => c.key);
    expect(enabling).toContain('V1_ENCRYPTION_BYPASS');
    expect(enabling).toContain('LAND_BRE_STATUS_BYPASS');
    expect(enabling).toHaveLength(2);
  });
});

/* ---------------------------------------------------------------- formatting */

describe('bypass: serializing', () => {
  it('detects the four-space indent the real file uses', () => {
    expect(detectIndent(`{\n    "A": true\n}\n`)).toBe(4);
  });

  it('detects two-space and tab indents', () => {
    expect(detectIndent(`{\n  "A": true\n}\n`)).toBe(2);
    expect(detectIndent(`{\n\t"A": true\n}\n`)).toBe('\t');
  });

  it('falls back to four spaces for a single-line file', () => {
    expect(detectIndent('{"A":true}')).toBe(4);
  });

  it('round-trips a four-space file byte for byte', () => {
    const text = `${JSON.stringify(SAMPLE, null, 4)}\n`;
    expect(serializeConfig(JSON.parse(text), detectIndent(text))).toBe(text);
  });
});

describe('bypass: diffing two files', () => {
  it('reports changed, added and removed keys', () => {
    const diff = diffConfigs({ A: true, B: 1, C: 'x' }, { A: false, B: 1, D: 'y' });
    expect(diff).toHaveLength(3);
    expect(diff.find((d) => d.key === 'A').kind).toBe('changed');
    expect(diff.find((d) => d.key === 'C').kind).toBe('removed');
    expect(diff.find((d) => d.key === 'D').kind).toBe('added');
  });

  it('reports nothing for identical files', () => {
    expect(diffConfigs(SAMPLE, JSON.parse(JSON.stringify(SAMPLE)))).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------- reading */

describe('bypass: reading the file', () => {
  it('reads, hashes and types the file', async () => {
    const target = await makeTarget();
    const current = await readConfig(target);
    expect(current.config.USER_OTP_BYPASS).toBe(true);
    expect(current.indent).toBe(4);
    expect(current.reformats).toBeFalsy();
    expect(current.sha256).toBe(sha256(current.text));
  });

  it('refuses a file it cannot parse instead of overwriting it', async () => {
    const target = await makeTarget();
    await fsp.writeFile(target.configPath, '{ "A": true,,, }', 'utf8');
    const error = await expectRejection(() => readConfig(target), { code: 'CONFIG_MALFORMED' });
    expect(error.message).toContain('not valid JSON');
  });

  it('reports a missing file clearly', async () => {
    const target = await makeTarget();
    await fsp.rm(target.configPath);
    await expectRejection(() => readConfig(target), { code: 'CONFIG_UNREADABLE' });
  });

  it('notices when the file formatting is not what this tool writes', async () => {
    const target = await makeTarget();
    await fsp.writeFile(target.configPath, JSON.stringify(SAMPLE), 'utf8');
    const current = await readConfig(target);
    expect(current.reformats).toBeTruthy();
  });
});

describe('bypass: pm2 status', () => {
  it('reads status, pid and restart count out of jlist', async () => {
    const target = await makeTarget();
    const snapshot = await pm2Snapshot(target);
    expect(snapshot.ok).toBeTruthy();
    expect(snapshot.status).toBe('online');
    expect(snapshot.restarts).toBe(0);
  });

  it('reports a process pm2 does not know about', async () => {
    const target = await makeTarget();
    const snapshot = await pm2Snapshot({ ...target, pm2Name: 'not-running' });
    expect(snapshot.ok).toBeFalsy();
    expect(snapshot.reason).toContain('no process named');
  });
});

/* --------------------------------------------------------------- apply flow */

describe('bypass: applying a change', () => {
  it('backs up, writes, restarts, and verifies', async () => {
    const target = await makeTarget();
    const before = await readConfig(target);

    const run = await collect((emit) =>
      applyBypassChanges({
        target,
        changes: [{ key: 'USER_OTP_BYPASS', to: false }],
        expectedSha256: before.sha256,
        username: 'tester',
        emit,
      })
    );

    expect(run.result.ok).toBeTruthy();
    expect(run.steps.backup).toBe('ok');
    expect(run.steps.write).toBe('ok');
    expect(run.steps.restart).toBe('ok');
    expect(run.steps.health).toBe('ok');
    expect(run.done.asserted).toBe('pm2');

    const after = await readConfig(target);
    expect(after.config.USER_OTP_BYPASS).toBe(false);
    // Everything else is untouched.
    expect(after.config.BYPASS).toBe(true);
    expect(after.config.LAND_BRE_STATUS_BYPASS).toEqual(['bre_status', 'land_bre_status']);
    expect(Object.keys(after.config)).toEqual(Object.keys(before.config));

    // The restart actually ran.
    expect(readState(target).restarts).toBe(1);
  });

  it('keeps the file valid JSON with the original indentation', async () => {
    const target = await makeTarget();
    const before = await readConfig(target);
    await collect((emit) =>
      applyBypassChanges({
        target,
        changes: [{ key: 'MOBILE_BYPASS', to: false }],
        expectedSha256: before.sha256,
        username: 'tester',
        emit,
      })
    );
    const text = await fsp.readFile(target.configPath, 'utf8');
    expect(detectIndent(text)).toBe(4);
    expect(text.endsWith('\n')).toBeTruthy();
    JSON.parse(text); // throws if we ever write something nano-like
  });

  it('writes a backup that reproduces the pre-change file', async () => {
    const target = await makeTarget();
    const before = await readConfig(target);

    const run = await collect((emit) =>
      applyBypassChanges({
        target,
        changes: [{ key: 'BYPASS', to: false }],
        expectedSha256: before.sha256,
        username: 'tester',
        emit,
      })
    );

    const backups = await listBackups(target);
    expect(backups).toHaveLength(1);
    expect(backups[0].id).toBe(run.done.backupId);
    expect(backups[0].by).toBe('tester');

    const backupText = await fsp.readFile(
      path.join(target.backupsDir, `bypass-${backups[0].id}.json`),
      'utf8'
    );
    expect(backupText).toBe(before.text);
  });

  it('records who changed what in the audit log', async () => {
    const target = await makeTarget();
    const before = await readConfig(target);
    await collect((emit) =>
      applyBypassChanges({
        target,
        changes: [{ key: 'V1_ENCRYPTION_BYPASS', to: true }],
        expectedSha256: before.sha256,
        username: 'auditor',
        emit,
      })
    );

    const audit = await readAudit(10);
    const mine = audit.filter((e) => e.user === 'auditor');
    expect(mine.length >= 2).toBeTruthy();
    expect(mine[0].phase).toBe('verified');
    expect(mine[0].changes[0].key).toBe('V1_ENCRYPTION_BYPASS');
    expect(mine[0].changes[0].to).toBe(true);
  });

  it('warns in the log when a bypass is being enabled', async () => {
    const target = await makeTarget();
    const before = await readConfig(target);
    const run = await collect((emit) =>
      applyBypassChanges({
        target,
        changes: [{ key: 'V1_ENCRYPTION_BYPASS', to: true }],
        expectedSha256: before.sha256,
        username: 'tester',
        emit,
      })
    );
    expect(run.log).toContain('ENABLED');
  });

  it('refuses to write when the file changed since it was read', async () => {
    const target = await makeTarget();
    const before = await readConfig(target);

    // Someone else edits over SSH between the review and the apply.
    await fsp.writeFile(
      target.configPath,
      `${JSON.stringify({ ...SAMPLE, MOBILE_BYPASS: false }, null, 4)}\n`,
      'utf8'
    );

    const run = await collect((emit) =>
      applyBypassChanges({
        target,
        changes: [{ key: 'USER_OTP_BYPASS', to: false }],
        expectedSha256: before.sha256,
        username: 'tester',
        emit,
      })
    );

    expect(run.result.ok).toBeFalsy();
    expect(run.error.code).toBe('STALE_READ');
    expect(run.error.configUntouched).toBeTruthy();
    // Their edit survived, and no restart happened.
    const after = await readConfig(target);
    expect(after.config.MOBILE_BYPASS).toBe(false);
    expect(after.config.USER_OTP_BYPASS).toBe(true);
    expect(readState(target).restarts).toBe(0);
  });

  it('refuses a change whose result does not match what was reviewed', async () => {
    const target = await makeTarget();
    const before = await readConfig(target);

    const run = await collect((emit) =>
      applyBypassChanges({
        target,
        changes: [{ key: 'USER_OTP_BYPASS', to: false }],
        expectedSha256: before.sha256,
        expectedNextSha256: sha256('something else entirely'),
        username: 'tester',
        emit,
      })
    );

    expect(run.result.ok).toBeFalsy();
    expect(run.error.code).toBe('PLAN_MISMATCH');
    expect(readState(target).restarts).toBe(0);
    expect((await readConfig(target)).text).toBe(before.text);
  });

  it('re-validates the change list at apply time, not just at review time', async () => {
    const target = await makeTarget();
    const before = await readConfig(target);

    // A client that skipped the plan endpoint and posted straight here.
    const run = await collect((emit) =>
      applyBypassChanges({
        target,
        changes: [{ key: 'NOT_A_REAL_FLAG', to: true }],
        expectedSha256: before.sha256,
        username: 'tester',
        emit,
      })
    );

    expect(run.result.ok).toBeFalsy();
    expect(run.error.code).toBe('UNKNOWN_KEY');
    expect((await readConfig(target)).text).toBe(before.text);
  });

  it('restores the previous file when the process does not come back', async () => {
    const target = await makeTarget();
    const before = await readConfig(target);

    const run = await collect((emit) =>
      applyBypassChanges({
        target,
        // The fake pm2 reports `errored` for this config, as the real backend
        // would for a config it cannot boot with.
        changes: [{ key: 'BROKEN', to: true }],
        expectedSha256: before.sha256,
        username: 'tester',
        emit,
      })
    );

    expect(run.result.ok).toBeFalsy();
    expect(run.steps.health).toBe('failed');
    expect(run.steps.rollback).toBe('ok');
    expect(run.error.rolledBack).toBeTruthy();

    // Byte-for-byte back to where it started, and restarted a second time.
    expect((await readConfig(target)).text).toBe(before.text);
    expect(readState(target).restarts).toBe(2);
  });

  it('records the rollback in the audit log', async () => {
    const target = await makeTarget();
    const before = await readConfig(target);
    await collect((emit) =>
      applyBypassChanges({
        target,
        changes: [{ key: 'BROKEN', to: true }],
        expectedSha256: before.sha256,
        username: 'rollbacker',
        emit,
      })
    );
    const audit = (await readAudit(10)).filter((e) => e.user === 'rollbacker');
    expect(audit[0].phase).toBe('rolled-back');
  });

  it('puts the file back when pm2 restart itself fails', async () => {
    const target = await makeTarget(SAMPLE, { failRestart: true });
    const before = await readConfig(target);

    const run = await collect((emit) =>
      applyBypassChanges({
        target,
        changes: [{ key: 'USER_OTP_BYPASS', to: false }],
        expectedSha256: before.sha256,
        username: 'tester',
        emit,
      })
    );

    expect(run.result.ok).toBeFalsy();
    expect(run.steps.restart).toBe('failed');
    expect(run.error.message).toContain('pm2 restart failed');
    // The restart could not be run at all, so the rollback cannot verify either —
    // but the file must still be back to its previous contents.
    expect(run.error.rolledBack).toBeFalsy();
    expect((await readConfig(target)).text).toBe(before.text);
    expect(run.log).toContain('restart it by hand');
  });

  it('prunes old backups down to keepBackups', async () => {
    const target = await makeTarget(SAMPLE, { keepBackups: 1 });

    for (const value of [false, true, false]) {
      const current = await readConfig(target);
      await collect((emit) =>
        applyBypassChanges({
          target,
          changes: [{ key: 'MOBILE_BYPASS', to: value }],
          expectedSha256: current.sha256,
          username: 'tester',
          emit,
        })
      );
    }

    expect(await listBackups(target)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------ restore flow */

describe('bypass: restoring a backup', () => {
  it('puts a previous version of the whole file back', async () => {
    const target = await makeTarget();
    const original = await readConfig(target);

    const applied = await collect((emit) =>
      applyBypassChanges({
        target,
        changes: [
          { key: 'USER_OTP_BYPASS', to: false },
          { key: 'LAND_BRE_STATUS_BYPASS', to: ['bre_status'] },
        ],
        expectedSha256: original.sha256,
        username: 'tester',
        emit,
      })
    );
    expect(applied.result.ok).toBeTruthy();

    const changed = await readConfig(target);
    const restored = await collect((emit) =>
      restoreBypassBackup({
        target,
        backupId: applied.done.backupId,
        expectedSha256: changed.sha256,
        username: 'tester',
        emit,
      })
    );

    expect(restored.result.ok).toBeTruthy();
    expect((await readConfig(target)).text).toBe(original.text);
    expect(readState(target).restarts).toBe(2);
  });

  it('refuses a backup id that is not one of ours', async () => {
    const target = await makeTarget();
    const current = await readConfig(target);
    const run = await collect((emit) =>
      restoreBypassBackup({
        target,
        backupId: '../../../../etc/passwd',
        expectedSha256: current.sha256,
        username: 'tester',
        emit,
      })
    );
    expect(run.result.ok).toBeFalsy();
    expect(run.error.code).toBe('INVALID_BACKUP');
  });

  it('refuses to restore a backup identical to the current file', async () => {
    const target = await makeTarget();
    const original = await readConfig(target);

    const applied = await collect((emit) =>
      applyBypassChanges({
        target,
        changes: [{ key: 'MOBILE_BYPASS', to: false }],
        expectedSha256: original.sha256,
        username: 'tester',
        emit,
      })
    );

    // Restore it once, so the file matches the backup again...
    const changed = await readConfig(target);
    await collect((emit) =>
      restoreBypassBackup({
        target,
        backupId: applied.done.backupId,
        expectedSha256: changed.sha256,
        username: 'tester',
        emit,
      })
    );

    // ...and a second restore of the same backup is a no-op, not a restart.
    const now = await readConfig(target);
    const restartsBefore = readState(target).restarts;
    const again = await collect((emit) =>
      restoreBypassBackup({
        target,
        backupId: applied.done.backupId,
        expectedSha256: now.sha256,
        username: 'tester',
        emit,
      })
    );

    expect(again.result.ok).toBeFalsy();
    expect(again.error.code).toBe('NO_CHANGES');
    expect(readState(target).restarts).toBe(restartsBefore);
  });
});

/* ------------------------------------------------------------ the allowlist */

describe('bypass: the shipped allowlist', () => {
  it('bypass-targets.json loads and validates', () => {
    const targets = listBypassTargets();
    expect(targets.length >= 1).toBeTruthy();
    for (const target of targets) {
      expect(typeof target.configPath).toBe('string');
      expect(target.configPath.startsWith('/')).toBeTruthy();
      expect(typeof target.pm2Name).toBe('string');
    }
  });

  it('never sends the restart argv to the browser', () => {
    for (const target of listBypassTargets()) {
      expect(Object.prototype.hasOwnProperty.call(target, 'restartCommand')).toBeFalsy();
      expect(Object.prototype.hasOwnProperty.call(target, 'statusCommand')).toBeFalsy();
    }
  });

  it('refuses a target key the client made up', () => {
    // getBypassTarget is the only path from a client string to a filesystem path.
    expect(listBypassTargets().some((t) => t.key === '../../etc')).toBeFalsy();
  });
});
