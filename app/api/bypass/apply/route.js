/**
 * POST /api/bypass/apply — write bypass.json, restart pm2, verify, roll back on failure.
 *
 * The one endpoint in this module that writes. It requires a confirm token
 * minted by /api/bypass, bound to both the current file digest and the digest of
 * the file to be written, so:
 *
 *   - a token cannot be replayed against a different change, or a different target;
 *   - if anyone edited the file over SSH since the review, the digest no longer
 *     matches and the change is refused instead of clobbering their edit.
 *
 * Streams the same event shape as the deployer: log / step / done / error.
 */

import { requireSession } from '@/lib/session-server';
import { applyBypassChanges, getBypassTarget, restoreBypassBackup, BACKUP_ID_RE } from '@/lib/bypass';
import {
  verifyConfirmToken,
  bypassConfirmPayload,
  bypassRestoreConfirmPayload,
} from '@/lib/confirm-token';

export const runtime = 'nodejs';
export const maxDuration = 300;

const SHA_RE = /^[0-9a-f]{64}$/;

/** Reduce the plan's change list back to the `{key: value}` form, shape-checked. */
function normalizeChanges(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out = [];
  for (const change of raw) {
    if (!change || typeof change.key !== 'string' || !('to' in change)) return null;
    out.push({ key: change.key, to: change.to });
  }
  return out;
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

  const kind = body.kind === 'restore' ? 'restore' : 'apply';
  const currentSha256 = body.currentSha256;
  if (typeof currentSha256 !== 'string' || !SHA_RE.test(currentSha256)) {
    return Response.json({ error: 'Missing or malformed currentSha256' }, { status: 400 });
  }

  /* -------------------------------------------------------------- validate */
  let changes = null;
  let backupId = null;
  let payload;

  if (kind === 'apply') {
    changes = normalizeChanges(body.changes);
    if (!changes) {
      return Response.json({ error: 'changes must be a non-empty list' }, { status: 400 });
    }
    if (typeof body.nextSha256 !== 'string' || !SHA_RE.test(body.nextSha256)) {
      return Response.json({ error: 'Missing or malformed nextSha256' }, { status: 400 });
    }
    payload = bypassConfirmPayload({
      targetKey: target.key,
      currentSha256,
      nextSha256: body.nextSha256,
    });
  } else {
    backupId = body.backupId;
    if (typeof backupId !== 'string' || !BACKUP_ID_RE.test(backupId.replace(/\.\d+$/, ''))) {
      return Response.json({ error: 'Invalid backup id' }, { status: 400 });
    }
    payload = bypassRestoreConfirmPayload({ targetKey: target.key, currentSha256, backupId });
  }

  const verdict = verifyConfirmToken(body.confirmToken, payload, session.username);
  if (!verdict.ok) {
    return Response.json(
      { error: verdict.reason, code: 'CONFIRM_INVALID', configUntouched: true },
      { status: 400 }
    );
  }

  console.log(
    `[bypass] ${kind.toUpperCase()} user=${session.username} target=${target.key} ` +
      (kind === 'apply' ? `keys=${changes.map((c) => c.key).join(',')}` : `backup=${backupId}`)
  );

  /* ----------------------------------------------------------------- stream */
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      send({ type: 'log', message: `${kind} started by ${session.username}` });
      send({ type: 'log', message: `file: ${target.configPath}` });
      send({ type: 'log', message: `restart: ${target.restartCommand.join(' ')}` });

      try {
        if (kind === 'apply') {
          await applyBypassChanges({
            target,
            changes,
            expectedSha256: currentSha256,
            expectedNextSha256: body.nextSha256,
            username: session.username,
            emit: send,
          });
        } else {
          await restoreBypassBackup({
            target,
            backupId,
            expectedSha256: currentSha256,
            username: session.username,
            emit: send,
          });
        }
      } catch (err) {
        console.error('[bypass] apply crashed:', err);
        send({ type: 'error', message: `Unexpected failure: ${err.message}` });
      } finally {
        send({ type: 'end' });
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
