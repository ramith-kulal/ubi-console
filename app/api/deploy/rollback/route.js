/**
 * POST /api/deploy/rollback — re-point a target at a previous release.
 *
 * Uses the same atomic swap + restart + health check as a deploy, and streams
 * the same event shape. A rollback that is not verified is a guess, and a
 * rollback is exactly the moment nobody wants to guess.
 */

import { requireSession } from '@/lib/session-server';
import { getTarget } from '@/lib/targets';
import { rollbackRelease } from '@/lib/deploy';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(request) {
  const { session, response } = await requireSession();
  if (!session) return response;

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Malformed request body' }, { status: 400 });
  }

  const { target: targetKey, releaseId } = body || {};

  const target = getTarget(targetKey);
  if (!target) {
    return Response.json({ error: 'Unknown deploy target' }, { status: 400 });
  }
  // Release ids are server-generated; accept only that shape so nothing
  // path-like can reach the filesystem helpers.
  if (typeof releaseId !== 'string' || !/^(?:\d{8}-\d{6}(?:-\d+)?|legacy-\d{8}(?:-\d{6})?)$/.test(releaseId)) {
    return Response.json({ error: 'Invalid release id' }, { status: 400 });
  }

  console.log(
    `[deploy] ROLLBACK user=${session.username} target=${target.key} to=${releaseId}`
  );

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

      send({ type: 'log', message: `rollback started by ${session.username}` });
      send({ type: 'log', message: `target: ${target.label} -> release ${releaseId}` });

      try {
        await rollbackRelease({
          target,
          releaseIdToRestore: releaseId,
          username: session.username,
          emit: send,
        });
      } catch (err) {
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
