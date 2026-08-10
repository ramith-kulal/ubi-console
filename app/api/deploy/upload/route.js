/**
 * POST /api/deploy/upload — receive a build archive, validate it, return a plan.
 *
 * NOTHING LIVE IS TOUCHED HERE. The upload lands in .staging/<uuid>/ and is
 * inspected from there; the caller gets a plan plus a confirm token, and only
 * /api/deploy/commit acts on it.
 *
 * This is a route handler using request.formData() rather than a Server Action
 * on purpose: Server Actions cap request bodies at 1MB by default, and these
 * archives are tens of megabytes.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { requireSession } from '@/lib/session-server';
import { getTarget, listTargets } from '@/lib/targets';
import { inspectZip, MAX_UPLOAD_BYTES } from '@/lib/zip-inspect';
import { createConfirmToken, deployConfirmPayload } from '@/lib/confirm-token';
import { createStagingDir, discardStaging, sweepStaging } from '@/lib/staging';
import { currentLiveRelease } from '@/lib/deploy';

export const runtime = 'nodejs';
// Uploading and hashing a 200MB archive can outrun the default budget.
export const maxDuration = 300;

export async function POST(request) {
  const { session, response } = await requireSession();
  if (!session) return response;

  let stagingId = null;

  try {
    const formData = await request.formData();
    const targetKey = formData.get('target');
    const file = formData.get('file');

    const target = getTarget(typeof targetKey === 'string' ? targetKey : '');
    if (!target) {
      return Response.json(
        {
          error: 'Unknown deploy target',
          validTargets: listTargets().map((t) => t.key),
        },
        { status: 400 }
      );
    }

    if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
      return Response.json({ error: 'No file uploaded under field "file"' }, { status: 400 });
    }

    const originalName = typeof file.name === 'string' ? file.name : 'upload.zip';
    // Only ever used as a label and as a basename for the retained artifact.
    const safeName = path.basename(originalName).replace(/[^\w.\-]/g, '_');

    if (typeof file.size === 'number' && file.size > MAX_UPLOAD_BYTES) {
      return Response.json(
        {
          error: `Upload is ${(file.size / 1024 / 1024).toFixed(1)} MB, over the ${
            MAX_UPLOAD_BYTES / 1024 / 1024
          } MB cap`,
        },
        { status: 413 }
      );
    }

    await sweepStaging();

    const staging = await createStagingDir();
    stagingId = staging.id;
    const zipPath = path.join(staging.dir, safeName.endsWith('.zip') ? safeName : 'upload.zip');

    // Stream to disk rather than buffering: a 200MB Buffer per concurrent
    // upload is avoidable memory pressure on a box already running five apps.
    if (typeof file.stream === 'function') {
      const nodeStream = Readable.fromWeb(file.stream());
      const handle = await fsp.open(zipPath, 'w', 0o600);
      try {
        const writeStream = handle.createWriteStream();
        await new Promise((resolve, reject) => {
          nodeStream.on('error', reject);
          writeStream.on('error', reject);
          writeStream.on('finish', resolve);
          nodeStream.pipe(writeStream);
        });
      } finally {
        await handle.close().catch(() => {});
      }
    } else {
      await fsp.writeFile(zipPath, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
    }

    /* ---- validate: magic bytes, zip-slip, index.html, size caps ---- */
    let plan;
    try {
      plan = await inspectZip(zipPath, { liveLink: target.liveLink });
    } catch (err) {
      await discardStaging(stagingId);
      console.log(
        `[deploy] REJECTED upload user=${session.username} target=${target.key} ` +
          `file=${safeName} code=${err.code || 'INVALID'}: ${err.message}`
      );
      return Response.json(
        {
          error: err.message,
          code: err.code || 'INVALID_ARCHIVE',
          // Say it plainly: a rejected upload never reached the live site.
          liveUntouched: true,
        },
        { status: 422 }
      );
    }

    const liveRelease = await currentLiveRelease(target);

    const token = createConfirmToken(
      deployConfirmPayload({ targetKey: target.key, stagingId, sha256: plan.sha256 }),
      session.username
    );

    console.log(
      `[deploy] staged upload user=${session.username} target=${target.key} ` +
        `file=${safeName} sha256=${plan.sha256.slice(0, 12)} entries=${plan.entryCount}`
    );

    return Response.json({
      ok: true,
      stagingId,
      confirmToken: token,
      artifactName: safeName,
      target: {
        key: target.key,
        label: target.label,
        liveLink: target.liveLink,
        healthUrl: target.healthUrl,
        pm2Name: target.pm2Name || target.restartCommand[target.restartCommand.length - 1],
      },
      currentLiveRelease: liveRelease ? path.basename(liveRelease) : null,
      liveLinkIsSymlink: liveRelease !== null,
      plan: {
        sha256: plan.sha256,
        zipBytes: plan.zipBytes,
        entryCount: plan.entryCount,
        totalUncompressedBytes: plan.totalUncompressedBytes,
        wrapper: plan.wrapper,
        indexCopyFrom: plan.indexCopyFrom,
        mainBundle: plan.mainBundle,
        liveMainBundle: plan.liveMainBundle,
        warnings: plan.warnings,
        diff: {
          hasLive: plan.diff.hasLive,
          identical: plan.diff.identical,
          added: plan.diff.added.slice(0, 200),
          removed: plan.diff.removed.slice(0, 200),
          changed: plan.diff.changed.slice(0, 200),
          addedCount: plan.diff.added.length,
          removedCount: plan.diff.removed.length,
          changedCount: plan.diff.changed.length,
        },
      },
    });
  } catch (err) {
    if (stagingId) await discardStaging(stagingId);
    console.error('[deploy] upload failed:', err);
    return Response.json(
      { error: `Upload failed: ${err.message}`, liveUntouched: true },
      { status: 500 }
    );
  }
}
