/**
 * POST /api/deploy/commit — act on a validated, staged upload.
 *
 * Streams Server-Sent Events so the UI shows real steps and real pm2 output as
 * they happen. A deploy takes ~5-20s including restart and health retries; a
 * spinner followed by a verdict would hide exactly the part an operator needs
 * to see when something goes wrong.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { requireSession } from '@/lib/session-server';
import { getTarget } from '@/lib/targets';
import { verifyConfirmToken, deployConfirmPayload } from '@/lib/confirm-token';
import { resolveStagingDir, discardStaging } from '@/lib/staging';
import { inspectZip } from '@/lib/zip-inspect';
import { deployRelease } from '@/lib/deploy';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Find the single staged .zip inside a staging directory. */
async function findStagedZip(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const zips = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.zip'));
  if (zips.length !== 1) {
    throw new Error(`Expected exactly one staged archive, found ${zips.length}`);
  }
  return path.join(dir, zips[0].name);
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

  const { target: targetKey, stagingId, confirmToken } = body || {};

  const target = getTarget(targetKey);
  if (!target) {
    return Response.json({ error: 'Unknown deploy target' }, { status: 400 });
  }

  let stagingDir;
  try {
    stagingDir = resolveStagingDir(stagingId);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  if (!fs.existsSync(stagingDir)) {
    return Response.json(
      { error: 'Staged upload not found — it may have expired. Re-upload the archive.' },
      { status: 410 }
    );
  }

  let zipPath;
  try {
    zipPath = await findStagedZip(stagingDir);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }

  // Re-inspect rather than trusting the plan the client echoes back. The client
  // could claim any wrapper folder or bundle name, and both feed the extraction
  // path and the health assertion.
  let plan;
  try {
    plan = await inspectZip(zipPath, { liveLink: target.liveLink });
  } catch (err) {
    await discardStaging(stagingId);
    return Response.json(
      { error: err.message, code: err.code, liveUntouched: true },
      { status: 422 }
    );
  }

  // The token is bound to this target, this staged upload, and this digest.
  const check = verifyConfirmToken(
    confirmToken,
    deployConfirmPayload({ targetKey: target.key, stagingId, sha256: plan.sha256 }),
    session.username
  );
  if (!check.ok) {
    return Response.json({ error: check.reason, liveUntouched: true }, { status: 403 });
  }

  const artifactName = path.basename(zipPath);

  console.log(
    `[deploy] COMMIT user=${session.username} target=${target.key} ` +
      `artifact=${artifactName} sha256=${plan.sha256.slice(0, 12)}`
  );

  /* ------------------------------------------------------------ SSE stream */
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

      send({ type: 'log', message: `deploy started by ${session.username}` });
      send({ type: 'log', message: `target: ${target.label} (${target.key})` });
      send({ type: 'log', message: `artifact: ${artifactName}` });

      try {
        await deployRelease({
          target,
          zipPath,
          plan,
          username: session.username,
          artifactName,
          emit: send,
        });
      } catch (err) {
        send({ type: 'error', message: `Unexpected failure: ${err.message}` });
      } finally {
        // Staging is scratch space; the artifact itself is retained beside the
        // release directory by deployRelease.
        await discardStaging(stagingId);
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
      // Nothing proxies this (loopback only), but be explicit anyway.
      'x-accel-buffering': 'no',
    },
  });
}
