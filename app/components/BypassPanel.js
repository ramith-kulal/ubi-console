'use client';

/**
 * BypassPanel — one target's `src/config/bypass.json`, as switches.
 *
 * Flip a switch, then press one button. There is no separate review step and no
 * confirm dialog, because neither was earning its click: the pending change is
 * printed in the action bar directly above the button, and the button says what
 * it does ("Apply 2 changes & restart ubi-backend"). Design principle 2 — a
 * destructive action shows exactly what it will affect, first — is satisfied by
 * showing it inline rather than behind two more clicks.
 *
 * What still stands between a mis-click and a restart:
 *   - editing is local; nothing is sent until the button is pressed
 *   - the button is red, and says "Enable" when a change weakens a check
 *   - the server re-validates and digest-binds the write (see lib/bypass.js)
 */

import { useMemo, useState } from 'react';
import { streamEvents } from './sse';
import ProgressLog from './ProgressLog';

const STATE = { EDIT: 'edit', RUNNING: 'running', FINISHED: 'finished' };

/** The editable representation of a value: a boolean, or text in an input. */
function toRaw(type, value) {
  if (type === 'boolean') return value === true;
  if (type === 'stringArray') return value.join(', ');
  return String(value);
}

/** Back to the JSON value the server will be asked to write. */
function fromRaw(type, raw) {
  if (type === 'boolean') return raw === true;
  if (type === 'stringArray') {
    return String(raw)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }
  if (type === 'number') {
    const n = Number(String(raw).trim());
    return Number.isFinite(n) ? n : String(raw);
  }
  return String(raw);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Short, readable form of a value for the change summary. */
function brief(value) {
  // undefined shows up in a restore diff, where a key was added or removed.
  if (value === undefined) return '(absent)';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) return value.length ? `[${value.join(', ')}]` : '[]';
  return JSON.stringify(value);
}

/** true when a change relaxes a check rather than tightening one. */
function isEnabling(change) {
  if (change.type === 'boolean') return change.to === true;
  if (change.type === 'stringArray') return change.to.length > change.from.length;
  return false;
}

function ChangeChip({ change }) {
  return (
    <span className={`change-chip${isEnabling(change) ? ' enabling' : ''}`}>
      <span className="change-chip-key">{change.key}</span>
      <span className="faint">{brief(change.from)}</span>
      <span className="faint">→</span>
      <strong>{brief(change.to)}</strong>
    </span>
  );
}

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The form's starting point: every editable key at its current value. */
function seedDraft(config) {
  const seeded = {};
  for (const entry of config?.keys || []) {
    if (entry.editable) seeded[entry.key] = toRaw(entry.type, entry.value);
  }
  return seeded;
}

export default function BypassPanel({ target, onChanged }) {
  const config = target.config;

  const [state, setState] = useState(STATE.EDIT);
  // Seeded on the first render, not in an effect: an effect would paint one
  // frame with every switch OFF, which is a lie about the file.
  const [draft, setDraft] = useState(() => seedDraft(config));
  const [error, setError] = useState(null);
  const [showFile, setShowFile] = useState(false);
  const [showBackups, setShowBackups] = useState(false);
  const [backupPlan, setBackupPlan] = useState(null); // { backupId, diff, ... }
  const [steps, setSteps] = useState({});
  const [logs, setLogs] = useState([]);
  const [outcome, setOutcome] = useState(null);

  // Re-seed whenever the file on disk changes identity. Anything half-typed is
  // deliberately discarded then: it was typed against a file that no longer exists.
  const [seededSha, setSeededSha] = useState(config?.sha256 || null);
  if (config && config.sha256 !== seededSha) {
    setSeededSha(config.sha256);
    setDraft(seedDraft(config));
    setError(null);
    setState(STATE.EDIT);
  }

  const pending = useMemo(() => {
    const out = [];
    for (const entry of config?.keys || []) {
      if (!entry.editable) continue;
      const raw = draft[entry.key];
      if (raw === undefined) continue;
      const next = fromRaw(entry.type, raw);
      if (!same(next, entry.value)) {
        out.push({ key: entry.key, type: entry.type, from: entry.value, to: next });
      }
    }
    return out;
  }, [config, draft]);

  const enabling = pending.filter(isEnabling);

  function setValue(key, raw) {
    setDraft((prev) => ({ ...prev, [key]: raw }));
    setError(null);
  }

  function reset() {
    setDraft(seedDraft(config));
    setError(null);
    setSteps({});
    setLogs([]);
    setOutcome(null);
    setBackupPlan(null);
    setState(STATE.EDIT);
  }

  async function post(body) {
    const res = await fetch('/api/bypass', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
    return data;
  }

  /** Stream a write. `plan` carries the confirm token the server just minted. */
  async function stream(plan, kind) {
    setState(STATE.RUNNING);
    setSteps({});
    setLogs([]);
    setOutcome(null);

    const body =
      kind === 'apply'
        ? {
            kind: 'apply',
            target: target.key,
            changes: plan.changes.map((c) => ({ key: c.key, to: c.to })),
            currentSha256: plan.currentSha256,
            nextSha256: plan.nextSha256,
            confirmToken: plan.confirmToken,
          }
        : {
            kind: 'restore',
            target: target.key,
            backupId: plan.backupId,
            currentSha256: plan.currentSha256,
            confirmToken: plan.confirmToken,
          };

    let failed = null;

    await streamEvents('/api/bypass/apply', body, (event) => {
      if (event.type === 'log') {
        const level = /health: OK|rollback: complete/.test(event.message)
          ? 'ok'
          : /^note:|ENABLED/.test(event.message)
            ? 'warn'
            : null;
        setLogs((prev) => [...prev, { text: event.message, kind: level }]);
      } else if (event.type === 'step') {
        setSteps((prev) => ({ ...prev, [event.name]: event.status }));
      } else if (event.type === 'done') {
        setLogs((prev) => [...prev, { text: `done: ${event.summary}`, kind: 'ok' }]);
        setOutcome({ ok: true, ...event });
      } else if (event.type === 'error') {
        failed = event;
        setLogs((prev) => [...prev, { text: event.message, kind: 'error' }]);
      }
    });

    if (failed) setOutcome({ ok: false, ...failed });
    setState(STATE.FINISHED);
    // The result stays on screen until the operator asks for the flags again.
  }

  /** One click: validate on the server, then write and restart. */
  async function apply() {
    setError(null);
    try {
      const plan = await post({
        kind: 'plan',
        target: target.key,
        changes: Object.fromEntries(pending.map((c) => [c.key, c.to])),
      });
      await stream(plan, 'apply');
    } catch (err) {
      setError(err.message);
      setState(STATE.EDIT);
    }
  }

  /** Expanding a backup fetches its diff — that is the review, and it is free. */
  async function openBackup(backupId) {
    setError(null);
    if (backupPlan?.backupId === backupId) {
      setBackupPlan(null);
      return;
    }
    try {
      setBackupPlan(await post({ kind: 'plan-restore', target: target.key, backupId }));
    } catch (err) {
      setError(err.message);
      setBackupPlan(null);
    }
  }

  /* ------------------------------------------------------------------ render */

  const proc = target.process;
  const online = proc?.ok && proc.status === 'online';
  const editing = state === STATE.EDIT;

  return (
    <div className="panel">
      <div className="panel-head">
        <span>{target.label}</span>
        <span className="topbar-spacer" />

        {editing ? (
          <>
            <button
              type="button"
              className="head-link"
              onClick={() => {
                setShowBackups((v) => !v);
                setBackupPlan(null);
              }}
            >
              backups ({target.backups.length})
            </button>
            <button type="button" className="head-link" onClick={() => setShowFile((v) => !v)}>
              {showFile ? 'hide raw' : 'raw file'}
            </button>
          </>
        ) : null}

        {proc?.ok ? (
          <span className={`tag ${online ? 'tag-live' : 'tag-danger'}`}>
            {target.pm2Name} {proc.status}
          </span>
        ) : (
          <span className="tag tag-warn">{target.pm2Name} status unknown</span>
        )}
      </div>

      <div className="panel-body stack-sm">
        {error ? (
          <div className="callout callout-danger">
            <span className="callout-icon">⛔</span>
            <div>
              {error}
              <div className="mono-sm faint" style={{ marginTop: 4 }}>
                Nothing was written.
              </div>
            </div>
          </div>
        ) : null}

        {target.error ? (
          <div className="callout callout-danger">
            <span className="callout-icon">⛔</span>
            <div>
              <strong>Cannot read this file{target.error.code ? ` — ${target.error.code}` : ''}.</strong>
              <div style={{ marginTop: 4 }}>{target.error.message}</div>
              <div className="mono-sm" style={{ marginTop: 6 }}>
                Nothing is written until the file parses. Fix it on the instance, or check
                configPath in bypass-targets.json.
              </div>
            </div>
          </div>
        ) : null}

        {!proc?.ok && proc?.reason ? (
          <div className="callout callout-warn">
            <span className="callout-icon">⚠</span>
            <div>
              pm2 could not be queried, so a restart cannot be verified.
              <span className="mono-sm faint"> {proc.reason}</span>
            </div>
          </div>
        ) : null}

        {/* -------------------------------------------------- flags (editing) */}
        {config && editing ? (
          <>
            <div className="flag-list">
              {config.keys.map((entry) => {
                const change = pending.find((c) => c.key === entry.key);
                const on = draft[entry.key] === true;
                return (
                  <div key={entry.key} className={`flag-row${change ? ' changed' : ''}`}>
                    <span className="flag-name" title={entry.key}>
                      {entry.key}
                    </span>

                    <span className="flag-control">
                      {entry.type === 'boolean' ? (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={entry.key}
                          className={`switch${on ? ' on' : ''}`}
                          onClick={() => setValue(entry.key, !on)}
                        >
                          <span className="switch-track">
                            <span className="switch-knob" />
                          </span>
                          <span className="switch-label">{on ? 'ON' : 'OFF'}</span>
                        </button>
                      ) : entry.editable ? (
                        <input
                          type="text"
                          className="flag-input"
                          value={draft[entry.key] ?? ''}
                          placeholder={entry.type === 'stringArray' ? 'comma-separated' : ''}
                          onChange={(e) => setValue(entry.key, e.target.value)}
                        />
                      ) : (
                        <span className="mono-sm faint" title="edit this one on the instance">
                          {JSON.stringify(entry.value)}
                        </span>
                      )}
                    </span>

                    <span className="flag-was">
                      {change ? <span className="faint">was {brief(change.from)}</span> : null}
                    </span>
                  </div>
                );
              })}
            </div>

            {showFile ? <pre className="logbox bypass-file">{config.text}</pre> : null}

            {/* ------------------------------------------------- action bar */}
            {pending.length ? (
              <>
                <div className="action-bar-spacer" />
                <div className="action-bar">
                  <div className="action-bar-changes">
                    {pending.map((change) => (
                      <ChangeChip key={change.key} change={change} />
                    ))}
                  </div>
                  <div className="action-bar-buttons">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={reset}>
                      Discard
                    </button>
                    <button type="button" className="btn btn-danger" onClick={apply}>
                      {enabling.length
                        ? `Enable ${enabling.length} bypass${enabling.length === 1 ? '' : 'es'} & restart`
                        : `Apply ${pending.length} change${pending.length === 1 ? '' : 's'} & restart`}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="faint mono-sm">
                {target.configPath} · applying backs the file up, writes atomically, restarts{' '}
                {target.pm2Name}, and restores the backup if it does not come back
              </div>
            )}
          </>
        ) : null}

        {/* --------------------------------------------------------- backups */}
        {editing && showBackups ? (
          <div className="stack-sm">
            {target.backups.length === 0 ? (
              <div className="empty">no backups yet — one is written before every change</div>
            ) : (
              target.backups.map((backup) => {
                const open = backupPlan?.backupId === backup.id;
                return (
                  <div key={backup.id} className={`backup-row${open ? ' open' : ''}`}>
                    <div className="ops-item" style={{ borderBottom: 'none' }}>
                      <div className="ops-item-data">
                        <span className="ops-kv">{formatWhen(backup.at)}</span>
                        <span className="ops-kv">
                          <span className="faint">by</span> {backup.by || '—'}
                        </span>
                        <span className="ops-kv faint">{backup.id}</span>
                      </div>
                      <div className="ops-item-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => openBackup(backup.id)}
                        >
                          {open ? 'close' : 'compare'}
                        </button>
                      </div>
                    </div>

                    {open ? (
                      <div className="backup-diff">
                        <div className="action-bar-changes">
                          {backupPlan.diff.map((entry) => (
                            <ChangeChip
                              key={entry.key}
                              change={{ ...entry, type: typeof entry.to === 'boolean' ? 'boolean' : 'other' }}
                            />
                          ))}
                        </div>
                        <div className="action-bar-buttons">
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            onClick={() => stream(backupPlan, 'restore')}
                          >
                            Restore this file & restart
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        ) : null}

        {/* ----------------------------------------------- running / finished */}
        {!editing ? (
          <div className="stack-sm">
            {outcome?.ok ? (
              <div className="callout callout-ok">
                <span className="callout-icon">✓</span>
                <div>
                  <strong>Done — {outcome.summary}.</strong> {target.pm2Name} is online.
                  <span className="faint mono-sm"> backup {outcome.backupId}</span>
                </div>
              </div>
            ) : null}

            {outcome && !outcome.ok ? (
              <div className="callout callout-danger">
                <span className="callout-icon">⛔</span>
                <div>
                  <strong>Failed.</strong> {outcome.message}
                  <div className="mono-sm" style={{ marginTop: 4 }}>
                    {outcome.rolledBack
                      ? 'The previous bypass.json was restored and the process is back online.'
                      : outcome.configUntouched
                        ? 'The file was not changed.'
                        : `The pre-change file is in the backups list${
                            outcome.backupId ? ` as ${outcome.backupId}` : ''
                          }.`}
                  </div>
                </div>
              </div>
            ) : null}

            <ProgressLog steps={steps} logs={logs} mode="bypass" />

            {state === STATE.FINISHED ? (
              <div className="row">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    reset();
                    if (onChanged) onChanged();
                  }}
                >
                  Back to the flags
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
