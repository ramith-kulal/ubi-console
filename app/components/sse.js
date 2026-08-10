'use client';

/**
 * streamEvents — POST a JSON body and consume the SSE response.
 *
 * EventSource cannot POST, and the commit/rollback endpoints need a body, so we
 * read the stream off fetch() and parse `data:` frames ourselves.
 */
export async function streamEvents(url, body, onEvent) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Failures before the stream opens come back as ordinary JSON.
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const data = await res.json().catch(() => ({}));
    onEvent({
      type: 'error',
      message: data.error || `Request failed (HTTP ${res.status})`,
      liveUntouched: data.liveUntouched,
    });
    onEvent({ type: 'end' });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Frames are separated by a blank line.
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch {
          /* ignore a partial/garbled frame rather than killing the stream */
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

/** Human-readable bytes for the plan panel. */
export function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
