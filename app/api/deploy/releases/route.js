/**
 * GET /api/deploy/releases          — releases for every target
 * GET /api/deploy/releases?target=x — releases for one target
 */

import path from 'node:path';
import { requireSession } from '@/lib/session-server';
import { getTarget, listTargets } from '@/lib/targets';
import { listReleases, currentLiveRelease, assertLiveLinkIsSymlink } from '@/lib/deploy';

export const runtime = 'nodejs';

async function describeTarget(target) {
  const { releases } = await listReleases(target);
  const live = await currentLiveRelease(target);

  // Surface the pre-migration state explicitly: the Releases screen is where
  // someone will notice that a target has never been migrated.
  let migrated = true;
  let migrationHint = null;
  try {
    await assertLiveLinkIsSymlink(target);
    migrated = live !== null || releases.length === 0;
    if (live === null) {
      migrated = false;
      migrationHint = `${target.liveLink} does not exist yet.`;
    }
  } catch (err) {
    migrated = false;
    migrationHint = err.message;
  }

  return {
    key: target.key,
    label: target.label,
    pm2Name: target.pm2Name || target.restartCommand[target.restartCommand.length - 1],
    liveLink: target.liveLink,
    releasesDir: target.releasesDir,
    healthUrl: target.healthUrl,
    keepReleases: target.keepReleases,
    liveRelease: live ? path.basename(live) : null,
    migrated,
    migrationHint,
    releases,
  };
}

export async function GET(request) {
  const { session, response } = await requireSession();
  if (!session) return response;

  const requested = new URL(request.url).searchParams.get('target');

  try {
    if (requested) {
      const target = getTarget(requested);
      if (!target) return Response.json({ error: 'Unknown deploy target' }, { status: 400 });
      return Response.json({ targets: [await describeTarget(target)] });
    }

    const all = [];
    for (const summary of listTargets()) {
      const target = getTarget(summary.key);
      all.push(await describeTarget(target));
    }
    return Response.json({ targets: all });
  } catch (err) {
    console.error('[deploy] releases listing failed:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
