'use client';

/**
 * DeployCard — one deploy target: drop a zip, read the plan, confirm, watch.
 *
 * The flow is deliberately three distinct states rather than one button:
 *   idle -> validated (nothing live touched yet) -> running -> finished
 * Design principle 2: a destructive action shows exactly what it will affect,
 * first. The plan panel is that showing.
 */

import { useRef, useState } from 'react';
import { streamEvents, formatBytes } from './sse';
import ProgressLog from './ProgressLog';

const STATE = {
  IDLE: 'idle',
  UPLOADING: 'uploading',
  VALIDATED: 'validated',
  RUNNING: 'running',
  FINISHED: 'finished',
};

function DiffColumn({ title, className, names, total }) {
  return (
    <div className={`diff-col ${className}`}>
      <div className="diff-col-head">
        <span>{title}</span>
        <span>{total}</span>
      </div>
      <div className="diff-list">
        {names.length === 0 ? (
          <div className="diff-item faint">none</div>
        ) : (
          names.map((name) => (
            <div className="diff-item" key={name} title={name}>
              {name}
            </div>
          ))
        )}
        {total > names.length ? (
          <div className="diff-item faint">… {total - names.length} more</div>
        ) : null}
      </div>
    </div>
  );
}

export default function DeployCard({ target, onChanged }) {
  const [state, setState] = useState(STATE.IDLE);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(null);
  const [upload, setUpload] = useState(null); // { stagingId, confirmToken, plan, artifactName }
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [steps, setSteps] = useState({});
  const [logs, setLogs] = useState([]);
  const [outcome, setOutcome] = useState(null);
  const fileInput = useRef(null);

  const busy = state === STATE.UPLOADING || state === STATE.RUNNING;

  function reset() {
    setState(STATE.IDLE);
    setError(null);
    setUpload(null);
    setSteps({});
    setLogs([]);
    setOutcome(null);
    setConfirmOpen(false);
    if (fileInput.current) fileInput.current.value = '';
  }

  function appendLog(text, kind) {
    setLogs((prev) => [...prev, { text, kind }]);
  }

  async function handleFile(file) {
    if (!file) return;

    setState(STATE.UPLOADING);
    setError(null);
    setOutcome(null);

    const formData = new FormData();
    formData.append('target', target.key);
    formData.append('file', file);

    try {
      const res = await fetch('/api/deploy/upload', { method: 'POST', body: formData });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // Rejections are the common case for a bad artifact; be explicit that
        // the live site was never involved.
        setError({
          message: data.error || `Upload failed (HTTP ${res.status})`,
          code: data.code,
          liveUntouched: data.liveUntouched !== false,
        });
        setState(STATE.IDLE);
        if (fileInput.current) fileInput.current.value = '';
        return;
      }

      setUpload(data);
      setState(STATE.VALIDATED);
    } catch (err) {
      setError({ message: `Upload failed: ${err.message}`, liveUntouched: true });
      setState(STATE.IDLE);
    }
  }

  async function commit() {
    setConfirmOpen(false);
    setState(STATE.RUNNING);
    setSteps({});
    setLogs([]);

    let failed = null;

    await streamEvents(
      '/api/deploy/commit',
      {
        target: target.key,
        stagingId: upload.stagingId,
        confirmToken: upload.confirmToken,
      },
      (event) => {
        if (event.type === 'log') {
          appendLog(event.message, /health: OK|rollback: complete/.test(event.message) ? 'ok' : null);
        } else if (event.type === 'step') {
          setSteps((prev) => ({ ...prev, [event.name]: event.status }));
        } else if (event.type === 'done') {
          appendLog(`done: release ${event.releaseId} is live`, 'ok');
          setOutcome({ ok: true, releaseId: event.releaseId, asserted: event.asserted });
        } else if (event.type === 'error') {
          failed = event;
          appendLog(event.message, 'error');
          if (event.rolledBack) {
            appendLog('the previous release was restored automatically', 'warn');
          } else if (event.liveUntouched) {
            appendLog('nothing live was changed', 'warn');
          }
        }
      }
    );

    if (failed) {
      setOutcome({
        ok: false,
        message: failed.message,
        rolledBack: failed.rolledBack,
        liveUntouched: failed.liveUntouched,
      });
    }

    setState(STATE.FINISHED);
    if (onChanged) onChanged();
  }

  const plan = upload?.plan;
  const identical = plan?.diff?.identical;

  return (
    <div className="panel">
      <div className="panel-head">
        <span>{target.label}</span>
        <span className="tag">{target.pm2Name}</span>
        <span className="topbar-spacer" />
        {target.liveRelease ? (
          <span className="tag tag-live">LIVE {target.liveRelease}</span>
        ) : (
          <span className="tag tag-warn">not migrated</span>
        )}
      </div>

      <div className="panel-body stack">
        <dl className="kv">
          <dt>live link</dt>
          <dd>{target.liveLink}</dd>
          <dt>releases</dt>
          <dd>{target.releasesDir}</dd>
          <dt>health url</dt>
          <dd>{target.healthUrl}</dd>
        </dl>

        {!target.migrated ? (
          <div className="callout callout-warn">
            <span className="callout-icon">⚠</span>
            <div>
              <strong>This target has not been migrated yet.</strong>
              <div className="mono-sm" style={{ marginTop: 4 }}>
                {target.migrationHint ||
                  `${target.liveLink} is still a real directory, not a symlink.`}
              </div>
              <div className="mono-sm" style={{ marginTop: 6 }}>
                node scripts/migrate-target.js {target.key} --confirm
              </div>
            </div>
          </div>
        ) : null}

        {/* ---------------------------------------------------------- idle */}
        {(state === STATE.IDLE || state === STATE.UPLOADING) && (
          <>
            <div
              className={`dropzone${dragging ? ' dragging' : ''}${busy ? ' busy' : ''}`}
              onClick={() => !busy && fileInput.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                if (!busy) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (!busy) handleFile(e.dataTransfer.files?.[0]);
              }}
            >
              {state === STATE.UPLOADING ? (
                <>
                  <div className="dropzone-title">
                    <span className="spin">⟳</span> uploading and validating…
                  </div>
                  <div className="dropzone-hint">nothing live is touched yet</div>
                </>
              ) : (
                <>
                  <div className="dropzone-title">Drop an Angular dist .zip here</div>
                  <div className="dropzone-hint">
                    or click to choose · max 200 MB · validated before anything is touched
                  </div>
                </>
              )}
            </div>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              style={{ display: 'none' }}
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </>
        )}

        {error ? (
          <div className="callout callout-danger">
            <span className="callout-icon">⛔</span>
            <div>
              <strong>Rejected{error.code ? ` — ${error.code}` : ''}</strong>
              <div style={{ marginTop: 4 }}>{error.message}</div>
              {error.liveUntouched ? (
                <div className="mono-sm" style={{ marginTop: 6 }}>
                  Nothing live was touched. {target.liveLink} is unchanged.
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ----------------------------------------------------- validated */}
        {state === STATE.VALIDATED && plan ? (
          <div className="stack">
            <div className="callout callout-ok">
              <span className="callout-icon">✓</span>
              <div>
                <strong>Archive validated.</strong> Nothing live has been touched yet.
              </div>
            </div>

            {plan.warnings?.map((warning) => (
              <div className="callout callout-warn" key={warning}>
                <span className="callout-icon">⚠</span>
                <div>{warning}</div>
              </div>
            ))}

            <dl className="kv">
              <dt>artifact</dt>
              <dd>{upload.artifactName}</dd>
              <dt>sha256</dt>
              <dd>{plan.sha256.slice(0, 24)}…</dd>
              <dt>size</dt>
              <dd>
                {formatBytes(plan.zipBytes)} zip · {formatBytes(plan.totalUncompressedBytes)}{' '}
                extracted · {plan.entryCount} files
              </dd>
              <dt>wrapper folder</dt>
              <dd>{plan.wrapper ? `${plan.wrapper}/ (will be stripped)` : 'none'}</dd>
              <dt>entry document</dt>
              <dd>
                {plan.indexCopyFrom
                  ? `${plan.indexCopyFrom} → copied to index.html`
                  : 'index.html'}
              </dd>
              <dt>new bundle</dt>
              <dd>{plan.mainBundle || <span className="tag tag-warn">none found</span>}</dd>
              <dt>live bundle</dt>
              <dd className="muted">{plan.liveMainBundle || '—'}</dd>
            </dl>

            {plan.diff.hasLive ? (
              <div className="diff-cols">
                <DiffColumn
                  title="added"
                  className="diff-added"
                  names={plan.diff.added}
                  total={plan.diff.addedCount}
                />
                <DiffColumn
                  title="removed"
                  className="diff-removed"
                  names={plan.diff.removed}
                  total={plan.diff.removedCount}
                />
                <DiffColumn
                  title="changed"
                  className="diff-changed"
                  names={plan.diff.changed}
                  total={plan.diff.changedCount}
                />
              </div>
            ) : (
              <div className="callout callout-info">
                <span className="callout-icon">ℹ</span>
                <div>No current release to diff against — this would be the first deploy.</div>
              </div>
            )}

            <div className="row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setConfirmOpen(true)}
                disabled={!target.migrated}
                title={
                  target.migrated ? undefined : 'Run migrate-target.js for this target first'
                }
              >
                Deploy to {target.label}
              </button>
              <button type="button" className="btn btn-ghost" onClick={reset}>
                Discard
              </button>
            </div>
          </div>
        ) : null}

        {/* ------------------------------------------------ running/finished */}
        {(state === STATE.RUNNING || state === STATE.FINISHED) && (
          <div className="stack">
            {outcome?.ok ? (
              <div className="callout callout-ok">
                <span className="callout-icon">✓</span>
                <div>
                  <strong>Release {outcome.releaseId} is live.</strong>
                  {outcome.asserted === 'html-only' ? (
                    <div className="mono-sm" style={{ marginTop: 4 }}>
                      Health check could only assert an HTML response — the archive had no
                      hashed bundle to verify against.
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {outcome && !outcome.ok ? (
              <div className="callout callout-danger">
                <span className="callout-icon">⛔</span>
                <div>
                  <strong>Deploy failed.</strong>
                  <div style={{ marginTop: 4 }}>{outcome.message}</div>
                  <div className="mono-sm" style={{ marginTop: 6 }}>
                    {outcome.rolledBack
                      ? 'The previous release was restored automatically.'
                      : outcome.liveUntouched
                        ? 'Nothing live was changed.'
                        : 'Check the log below and the Releases screen before retrying.'}
                  </div>
                </div>
              </div>
            ) : null}

            <ProgressLog steps={steps} logs={logs} mode="deploy" />

            {state === STATE.FINISHED ? (
              <div className="row">
                <button type="button" className="btn" onClick={reset}>
                  Deploy another build
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* -------------------------------------------------------- confirm */}
      {confirmOpen && plan ? (
        <div className="modal-backdrop" onClick={() => setConfirmOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>⚠</span>
              <span>Deploy to {target.label}?</span>
            </div>
            <div className="modal-body">
              <div className="callout callout-warn">
                <span className="callout-icon">⚠</span>
                <div>
                  This replaces the live build served on{' '}
                  <strong>{target.healthUrl}</strong> and restarts{' '}
                  <strong>{target.pm2Name}</strong>.
                </div>
              </div>

              {identical ? (
                <div className="callout callout-danger">
                  <span className="callout-icon">⛔</span>
                  <div>
                    <strong>This archive is identical to what is already live.</strong>
                    <div style={{ marginTop: 4 }}>
                      Deploying it changes nothing but still restarts the app. This is
                      usually a sign the wrong zip was picked.
                    </div>
                  </div>
                </div>
              ) : null}

              {plan.indexCopyFrom ? (
                <div className="callout callout-warn">
                  <span className="callout-icon">⚠</span>
                  <div>
                    This build&apos;s entry document is <strong>{plan.indexCopyFrom}</strong>, not
                    index.html. It will be copied to index.html so pm2&apos;s SPA fallback can
                    serve it.
                  </div>
                </div>
              ) : null}

              <dl className="kv">
                <dt>artifact</dt>
                <dd>{upload.artifactName}</dd>
                <dt>files</dt>
                <dd>
                  +{plan.diff.addedCount} / −{plan.diff.removedCount} / ~
                  {plan.diff.changedCount}
                </dd>
                <dt>bundle</dt>
                <dd>
                  {plan.liveMainBundle ? `${plan.liveMainBundle} → ` : ''}
                  {plan.mainBundle || 'unknown'}
                </dd>
                <dt>on failure</dt>
                <dd>automatic rollback to {target.liveRelease || 'previous release'}</dd>
              </dl>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={commit}>
                Confirm deploy
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
