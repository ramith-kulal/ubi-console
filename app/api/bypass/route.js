/**
 * Bypass flags API — read the config, and plan a change against it.
 *
 *   GET  /api/bypass                      — every target, its current flags, backups, audit tail
 *   POST /api/bypass {kind:'plan'}        — validate a proposed change, return the diff + a token
 *   POST /api/bypass {kind:'plan-restore'}— diff the current file against a backup, + a token
 *
 * Neither POST writes anything. The write lives behind /api/bypass/apply, which
 * requires the confirm token minted here, so the bytes that get written are the
 * bytes someone reviewed.
 */

import { requireSession } from '@/lib/session-server';
import {
  applyChanges,
  diffConfigs,
  enablingChanges,
  getBypassTarget,
  listBackups,
  listBypassTargets,
  planChanges,
  pm2Snapshot,
  readAudit,
  readBackup,
  readConfig,
  serializeConfig,
  sha256,
  BypassError,
} from '@/lib/bypass';
import { createConfirmToken, bypassConfirmPayload, bypassRestoreConfirmPayload } from '@/lib/confirm-token';

export const runtime = 'nodejs';

async function describeTarget(summary) {
  const target = getBypassTarget(summary.key);

  const out = { ...summary, config: null, error: null, backups: [], process: null };

  try {
    const current = await readConfig(target);
    out.config = {
      sha256: current.sha256,
      keys: current.keys,
      reformats: current.reformats,
      bytes: Buffer.byteLength(current.text),
      text: current.text,
    };
  } catch (err) {
    out.error = { message: err.message, code: err.code };
  }

  out.backups = await listBackups(target);

  const snapshot = await pm2Snapshot(target);
  out.process = snapshot.ok ? snapshot : { ok: false, reason: snapshot.reason };

  return out;
}

export async function GET() {
  const { session, response } = await requireSession();
  if (!session) return response;

  try {
    const targets = [];
    for (const summary of listBypassTargets()) {
      targets.push(await describeTarget(summary));
    }
    return Response.json({ ok: true, targets, audit: await readAudit(25) });
  } catch (err) {
    console.error('[bypass] listing failed:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request) {
  const { session, response } = await requireSession();
  if (!session) return response;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Malformed request body' }, { status: 400 });
  }

  const target = getBypassTarget(body?.target);
  if (!target) {
    return Response.json({ error: 'Unknown bypass target' }, { status: 400 });
  }

  try {
    const current = await readConfig(target);

    /* ---------------------------------------------------------------- plan */
    if (body.kind === 'plan') {
      const changes = planChanges(current.config, body.changes);
      const nextText = serializeConfig(applyChanges(current.config, changes), current.indent);
      const nextSha256 = sha256(nextText);

      const confirmToken = createConfirmToken(
        bypassConfirmPayload({
          targetKey: target.key,
          currentSha256: current.sha256,
          nextSha256,
        }),
        session.username
      );

      console.log(
        `[bypass] PLAN user=${session.username} target=${target.key} ` +
          `keys=${changes.map((c) => c.key).join(',')}`
      );

      return Response.json({
        ok: true,
        target: target.key,
        changes,
        enabling: enablingChanges(changes).map((c) => c.key),
        currentSha256: current.sha256,
        nextSha256,
        nextText,
        reformats: current.reformats,
        confirmToken,
      });
    }

    /* -------------------------------------------------------- plan-restore */
    if (body.kind === 'plan-restore') {
      const backup = await readBackup(target, body.backupId);
      const diff = diffConfigs(current.config, backup.config);

      if (!diff.length) {
        return Response.json(
          {
            error: `Backup ${body.backupId} is identical to the current file`,
            code: 'NO_CHANGES',
          },
          { status: 400 }
        );
      }

      const confirmToken = createConfirmToken(
        bypassRestoreConfirmPayload({
          targetKey: target.key,
          currentSha256: current.sha256,
          backupId: body.backupId,
        }),
        session.username
      );

      console.log(
        `[bypass] PLAN-RESTORE user=${session.username} target=${target.key} backup=${body.backupId}`
      );

      return Response.json({
        ok: true,
        target: target.key,
        backupId: body.backupId,
        diff,
        currentSha256: current.sha256,
        nextText: backup.text,
        confirmToken,
      });
    }

    return Response.json({ error: "kind must be 'plan' or 'plan-restore'" }, { status: 400 });
  } catch (err) {
    if (err instanceof BypassError) {
      return Response.json({ error: err.message, code: err.code }, { status: 400 });
    }
    console.error('[bypass] plan failed:', err);
    return Response.json({ error: err.message, code: 'PLAN_FAILED' }, { status: 500 });
  }
}
