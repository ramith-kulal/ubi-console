'use client';

/**
 * Releases — what is live, what came before, and one click back.
 *
 * Design principle 5: undo is one click from the screen you are already on.
 * The rollback runs the same swap + restart + health check as a deploy and
 * streams into the same log view, so "did it work" is answered on screen.
 */

import { useCallback, useEffect, useState } from 'react';
import { streamEvents } from '../components/sse';
import ProgressLog from '../components/ProgressLog';

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

export default function ReleasesPage() {
  const [targets, setTargets] = useState(null);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null); // { target, release }
  const [run, setRun] = useState(null); // { targetKey, releaseId, steps, logs, outcome, done }

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/deploy/releases', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Failed to load releases (HTTP ${res.status})`);
        return;
      }
      setTargets(data.targets);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function doRollback(target, release) {
    setConfirm(null);
    setRun({
      targetKey: target.key,
      targetLabel: target.label,
      releaseId: release.id,
      steps: {},
      logs: [],
      outcome: null,
      done: false,
    });

    let failed = null;

    await streamEvents(
      '/api/deploy/rollback',
      { target: target.key, releaseId: release.id },
      (event) => {
        setRun((prev) => {
          if (!prev) return prev;
          if (event.type === 'log') {
            return {
              ...prev,
              logs: [
                ...prev.logs,
                { text: event.message, kind: /health: OK/.test(event.message) ? 'ok' : null },
              ],
            };
          }
          if (event.type === 'step') {
            return { ...prev, steps: { ...prev.steps, [event.name]: event.status } };
          }
          if (event.type === 'done') {
            return {
              ...prev,
              logs: [...prev.logs, { text: `done: ${event.releaseId} is live`, kind: 'ok' }],
              outcome: { ok: true, releaseId: event.releaseId },
            };
          }
          if (event.type === 'error') {
            failed = event;
            return {
              ...prev,
              logs: [...prev.logs, { text: event.message, kind: 'error' }],
            };
          }
          return prev;
        });
      }
    );

    setRun((prev) =>
      prev
        ? {
            ...prev,
            done: true,
            outcome: failed ? { ok: false, message: failed.message } : prev.outcome,
          }
        : prev
    );
    load();
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Releases</h1>
        <span className="page-sub">newest first · rollback re-runs the full verify path</span>
      </div>

      {error ? (
        <div className="callout callout-danger" style={{ marginBottom: 13 }}>
          <span className="callout-icon">⛔</span>
          <div>{error}</div>
        </div>
      ) : null}

      {run ? (
        <div className="panel" style={{ marginBottom: 14 }}>
          <div className="panel-head">
            <span>
              Rolling back {run.targetLabel} → {run.releaseId}
            </span>
            <span className="topbar-spacer" />
            {run.done ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRun(null)}>
                Dismiss
              </button>
            ) : null}
          </div>
          <div className="panel-body stack">
            {run.outcome?.ok ? (
              <div className="callout callout-ok">
                <span className="callout-icon">✓</span>
                <div>
                  <strong>{run.outcome.releaseId} is live.</strong>
                </div>
              </div>
            ) : null}
            {run.outcome && !run.outcome.ok ? (
              <div className="callout callout-danger">
                <span className="callout-icon">⛔</span>
                <div>
                  <strong>Rollback failed.</strong>
                  <div style={{ marginTop: 4 }}>{run.outcome.message}</div>
                </div>
              </div>
            ) : null}
            <ProgressLog steps={run.steps} logs={run.logs} mode="rollback" />
          </div>
        </div>
      ) : null}

      <div className="stack">
        {(targets || []).map((target) => (
          <div className="panel" key={target.key}>
            <div className="panel-head">
              <span>{target.label}</span>
              <span className="tag">{target.pm2Name}</span>
              <span className="topbar-spacer" />
              <span className="tag faint">keep {target.keepReleases}</span>
              {target.liveRelease ? (
                <span className="tag tag-live">LIVE {target.liveRelease}</span>
              ) : (
                <span className="tag tag-warn">not migrated</span>
              )}
            </div>

            {!target.migrated ? (
              <div className="panel-body">
                <div className="callout callout-warn">
                  <span className="callout-icon">⚠</span>
                  <div>
                    <div>{target.migrationHint || 'This target is not using a symlink yet.'}</div>
                    <div className="mono-sm" style={{ marginTop: 6 }}>
                      node scripts/migrate-target.js {target.key} --confirm
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {target.releases.length === 0 ? (
              <div className="empty">no releases yet</div>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th style={{ width: 30 }} />
                    <th>release</th>
                    <th>deployed</th>
                    <th>by</th>
                    <th>artifact</th>
                    <th>bundle</th>
                    <th style={{ width: 96 }} />
                  </tr>
                </thead>
                <tbody>
                  {target.releases.map((release) => (
                    <tr key={release.id} className={release.isLive ? 'is-live' : undefined}>
                      <td>{release.isLive ? <span style={{ color: 'var(--ok)' }}>●</span> : ''}</td>
                      <td>
                        {release.id}
                        {release.isLive ? (
                          <span className="tag tag-live" style={{ marginLeft: 7 }}>
                            LIVE
                          </span>
                        ) : null}
                        {release.failed ? (
                          <span
                            className="tag tag-danger"
                            style={{ marginLeft: 7 }}
                            title={release.failureReason || 'This release failed its health check'}
                          >
                            FAILED
                          </span>
                        ) : null}
                      </td>
                      <td className="muted">{formatWhen(release.deployedAt)}</td>
                      <td className="muted">{release.deployedBy || '—'}</td>
                      <td className="muted" title={release.artifact || ''}>
                        {release.artifact || '—'}
                        {release.hasArtifact ? (
                          <span className="tag tag-ok" style={{ marginLeft: 6 }}>
                            kept
                          </span>
                        ) : null}
                      </td>
                      <td className="muted">{release.mainBundle || '—'}</td>
                      <td>
                        {release.isLive ? (
                          <span className="faint mono-sm">current</span>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={Boolean(run && !run.done) || !target.migrated}
                            onClick={() => setConfirm({ target, release })}
                          >
                            Roll back
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>

      {targets !== null && targets.length === 0 ? (
        <div className="panel">
          <div className="empty">no deploy targets configured</div>
        </div>
      ) : null}

      {confirm ? (
        <div className="modal-backdrop" onClick={() => setConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>⚠</span>
              <span>Roll back {confirm.target.label}?</span>
            </div>
            <div className="modal-body">
              <div className="callout callout-warn">
                <span className="callout-icon">⚠</span>
                <div>
                  This re-points <strong>{confirm.target.liveLink}</strong> at release{' '}
                  <strong>{confirm.release.id}</strong> and restarts{' '}
                  <strong>{confirm.target.pm2Name}</strong>.
                </div>
              </div>

              {confirm.release.failed ? (
                <div className="callout callout-danger">
                  <span className="callout-icon">⛔</span>
                  <div>
                    <strong>This release previously failed its health check.</strong>
                    <div style={{ marginTop: 4 }}>
                      It was never successfully served. Rolling back to it will most likely
                      fail the same check and revert again.
                    </div>
                    {confirm.release.failureReason ? (
                      <div className="mono-sm" style={{ marginTop: 6 }}>
                        {confirm.release.failureReason}
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}
              <dl className="kv">
                <dt>from (live)</dt>
                <dd>{confirm.target.liveRelease || '—'}</dd>
                <dt>to</dt>
                <dd>{confirm.release.id}</dd>
                <dt>deployed</dt>
                <dd>
                  {formatWhen(confirm.release.deployedAt)} by {confirm.release.deployedBy || '—'}
                </dd>
                <dt>artifact</dt>
                <dd>{confirm.release.artifact || '—'}</dd>
                <dt>bundle</dt>
                <dd>{confirm.release.mainBundle || 'unknown'}</dd>
              </dl>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => doRollback(confirm.target, confirm.release)}
              >
                Confirm rollback
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
