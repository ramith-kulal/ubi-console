'use client';

/**
 * BypassPanel — one target's `src/config/bypass.json`, as switches.
 *
 * The flow is deliberately not one click:
 *
 *   edit locally  →  Review changes (server validates, nothing written)
 *                 →  confirm dialog (says what will be enabled, and that pm2 restarts)
 *                 →  streamed backup / write / restart / verify
 *
 * Editing is local until "Review changes": a mis-click on a switch must not be a
 * restart of the backend. The review step is server-side because the set of
 * editable keys and their types come from the file, not from the browser.
 */

import { useEffect, useMemo, useState } from 'react';
import { streamEvents } from './sse';
import ProgressLog from './ProgressLog';

const STATE = { EDIT: 'edit', REVIEWED: 'reviewed', RUNNING: 'running', FINISHED: 'finished' };

const TYPE_LABEL = {
  boolean: 'bool',
  string: 'text',
  number: 'num',
  stringArray: 'list',
  readonly: 'nested',
};

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

function ValuePreview({ value }) {
  if (value === undefined) return <span className="cell-null">—</span>;
  if (typeof value === 'boolean') {
    return <span className={value ? 'tag tag-warn' : 'tag tag-ok'}>{value ? 'true' : 'false'}</span>;
  }
  return <span className="mono-sm">{JSON.stringify(value)}</span>;
}

function ChangeLine({ change }) {
  return (
    <div className="bypass-diff-line">
      <span className="bypass-diff-key">{change.key}</span>
      <ValuePreview value={change.from} />
      <span className="faint">→</span>
      <ValuePreview value={change.to} />
      {change.kind ? <span className="tag">{change.kind}</span> : null}
    </div>
  );
}

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

export default function BypassPanel({ target, onChanged }) {
  const config = target.config;

  const [state, setState] = useState(STATE.EDIT);
  const [draft, setDraft] = useState({});
  const [plan, setPlan] = useState(null); // { kind, changes|diff, confirmToken, ... }
  const [error, setError] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showFile, setShowFile] = useState(false);
  const [showBackups, setShowBackups] = useState(false);
  const [steps, setSteps] = useState({});
  const [logs, setLogs] = useState([]);
  const [outcome, setOutcome] = useState(null);

  // Re-seed the form whenever the file on disk changes identity (first load, and
  // after an apply). Anything half-typed is deliberately discarded then: it was
  // typed against a file that no longer exists.
  useEffect(() => {
    if (!config) return;
    const seeded = {};
    for (const entry of config.keys) {
      if (entry.editable) seeded[entry.key] = toRaw(entry.type, entry.value);
    }
    setDraft(seeded);
    setPlan(null);
    setError(null);
    setState(STATE.EDIT);
  }, [config?.sha256]); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = useMemo(() => {
    if (!config) return [];
    const out = [];
    for (const entry of config.keys) {
      if (!entry.editable) continue;
      const raw = draft[entry.key];
      if (raw === undefined) continue;
      const next = fromRaw(entry.type, raw);
      if (!same(next, entry.value)) out.push({ key: entry.key, type: entry.type, from: entry.value, to: next });
    }
    return out;
  }, [config, draft]);

  function setValue(key, raw) {
    setDraft((prev) => ({ ...prev, [key]: raw }));
    if (state !== STATE.EDIT) {
      // Any edit invalidates a plan built from the previous draft.
      setState(STATE.EDIT);
      setPlan(null);
    }
  }

  function revert(entry) {
    setValue(entry.key, toRaw(entry.type, entry.value));
  }

  function resetAll() {
    const seeded = {};
    for (const entry of config?.keys || []) {
      if (entry.editable) seeded[entry.key] = toRaw(entry.type, entry.value);
    }
    setDraft(seeded);
    setPlan(null);
    setError(null);
    setSteps({});
    setLogs([]);
    setOutcome(null);
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

  async function review() {
    setError(null);
    try {
      const changes = Object.fromEntries(pending.map((c) => [c.key, c.to]));
      const data = await post({ kind: 'plan', target: target.key, changes });
      setPlan({ kind: 'apply', ...data });
      setState(STATE.REVIEWED);
    } catch (err) {
      setError(err.message);
    }
  }

  async function reviewRestore(backupId) {
    setError(null);
    try {
      const data = await post({ kind: 'plan-restore', target: target.key, backupId });
      setPlan({ kind: 'restore', ...data });
      setState(STATE.REVIEWED);
      setShowBackups(false);
    } catch (err) {
      setError(err.message);
    }
  }

  async function run() {
    if (!plan) return;
    setConfirmOpen(false);
    setState(STATE.RUNNING);
    setSteps({});
    setLogs([]);
    setOutcome(null);

    const body =
      plan.kind === 'apply'
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
        const kind = /health: OK|rollback: complete/.test(event.message)
          ? 'ok'
          : /^note:|ENABLED/.test(event.message)
            ? 'warn'
            : null;
        setLogs((prev) => [...prev, { text: event.message, kind }]);
      } else if (event.type === 'step') {
        setSteps((prev) => ({ ...prev, [event.name]: event.status }));
      } else if (event.type === 'done') {
        setLogs((prev) => [...prev, { text: `done: ${event.summary}`, kind: 'ok' }]);
        setOutcome({ ok: true, ...event });
      } else if (event.type === 'error') {
        failed = event;
        setLogs((prev) => [...prev, { text: event.message, kind: 'error' }]);
        if (event.configUntouched) {
          setLogs((prev) => [...prev, { text: 'the file was not changed', kind: 'warn' }]);
        }
      }
    });

    if (failed) setOutcome({ ok: false, ...failed });
    setState(STATE.FINISHED);
    // The result panel and the log stay on screen until the operator asks for
    // the flags again — a reload here would replace the outcome they need to read.
  }

  /* ------------------------------------------------------------------ render */

  const proc = target.process;
  const online = proc && proc.ok && proc.status === 'online';

  return (
    <div className="panel">
      <div className="panel-head">
        <span>{target.label}</span>
        <span className="tag">{target.pm2Name}</span>
        <span className="topbar-spacer" />
        {proc?.ok ? (
          <span className={`tag ${online ? 'tag-live' : 'tag-danger'}`}>
            {proc.status.toUpperCase()} · {proc.restarts ?? '?'} restarts
          </span>
        ) : (
          <span className="tag tag-warn">pm2 status unknown</span>
        )}
      </div>

      <div className="panel-body stack">
        <dl className="kv">
          <dt>config file</dt>
          <dd>{target.configPath}</dd>
          <dt>on apply</dt>
          <dd>
            backup → atomic write → pm2 restart {target.pm2Name} → verify
            {target.healthUrl ? ` → GET ${target.healthUrl}` : ''}
          </dd>
        </dl>

        {!proc?.ok && proc?.reason ? (
          <div className="callout callout-warn">
            <span className="callout-icon">⚠</span>
            <div>
              <strong>pm2 could not be queried.</strong>
              <div className="mono-sm" style={{ marginTop: 4 }}>{proc.reason}</div>
              <div style={{ marginTop: 4 }}>
                A change can still be written, but the restart cannot be verified.
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
                bypass-targets.json if the path is wrong.
              </div>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="callout callout-danger">
            <span className="callout-icon">⛔</span>
            <div>
              <strong>Rejected.</strong>
              <div style={{ marginTop: 4 }}>{error}</div>
              <div className="mono-sm" style={{ marginTop: 6 }}>The file was not touched.</div>
            </div>
          </div>
        ) : null}

        {/* ------------------------------------------------------- the flags */}
        {config && state !== STATE.RUNNING && state !== STATE.FINISHED ? (
          <div className="flag-list">
            {config.keys.map((entry) => {
              const changed = pending.find((c) => c.key === entry.key);
              return (
                <div key={entry.key} className={`flag-row${changed ? ' changed' : ''}`}>
                  <span className="flag-name" title={entry.key}>
                    {entry.key}
                  </span>
                  <span className="tag flag-type">{TYPE_LABEL[entry.type]}</span>

                  <span className="flag-control">
                    {entry.type === 'boolean' ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={draft[entry.key] === true}
                        className={`switch${draft[entry.key] === true ? ' on' : ''}`}
                        onClick={() => setValue(entry.key, !(draft[entry.key] === true))}
                      >
                        <span className="switch-track">
                          <span className="switch-knob" />
                        </span>
                        <span className="switch-label">
                          {draft[entry.key] === true ? 'ON' : 'OFF'}
                        </span>
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

                  <span className="flag-after">
                    {changed ? (
                      <>
                        <span className="tag tag-accent">was {JSON.stringify(changed.from)}</span>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => revert(entry)}
                        >
                          revert
                        </button>
                      </>
                    ) : null}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}

        {/* ------------------------------------------------------- edit footer */}
        {config && state === STATE.EDIT ? (
          <div className="row row-between">
            <span className="muted">
              {pending.length === 0
                ? 'No pending changes.'
                : `${pending.length} pending change${pending.length === 1 ? '' : 's'} — not written yet.`}
            </span>
            <span className="row">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowFile((v) => !v)}
              >
                {showFile ? 'hide file' : 'view file'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowBackups((v) => !v)}
              >
                backups ({target.backups.length})
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={resetAll}
                disabled={pending.length === 0}
              >
                Discard edits
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={review}
                disabled={pending.length === 0}
              >
                Review {pending.length || ''} change{pending.length === 1 ? '' : 's'}
              </button>
            </span>
          </div>
        ) : null}

        {showFile && config && state === STATE.EDIT ? (
          <pre className="logbox bypass-file">{config.text}</pre>
        ) : null}

        {/* --------------------------------------------------------- backups */}
        {showBackups ? (
          <div className="stack-sm">
            <div className="faint mono-sm">
              One backup per write, newest first. Restoring puts the whole file back and
              restarts — the current file is itself backed up first.
            </div>
            {target.backups.length === 0 ? (
              <div className="empty">no backups yet</div>
            ) : (
              target.backups.map((backup) => (
                <div className="ops-item" key={backup.id}>
                  <div className="ops-item-data">
                    <span className="ops-kv">
                      <span className="faint">id</span> {backup.id}
                    </span>
                    <span className="ops-kv">
                      <span className="faint">at</span> {formatWhen(backup.at)}
                    </span>
                    <span className="ops-kv">
                      <span className="faint">by</span> {backup.by || '—'}
                    </span>
                    <span className="ops-kv faint">{backup.bytes} B</span>
                  </div>
                  <div className="ops-item-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => reviewRestore(backup.id)}
                    >
                      Review restore
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        ) : null}

        {/* -------------------------------------------------------- reviewed */}
        {state === STATE.REVIEWED && plan ? (
          <div className="stack">
            <div className="callout callout-info">
              <span className="callout-icon">ℹ</span>
              <div>
                <strong>
                  {plan.kind === 'apply'
                    ? `${plan.changes.length} change(s) validated.`
                    : `Restore of backup ${plan.backupId} validated.`}
                </strong>{' '}
                Nothing has been written and {target.pm2Name} has not been restarted.
              </div>
            </div>

            {plan.kind === 'apply' && plan.enabling?.length ? (
              <div className="callout callout-warn">
                <span className="callout-icon">⚠</span>
                <div>
                  <strong>
                    {plan.enabling.length} bypass(es) will be ENABLED, which relaxes a check:
                  </strong>
                  <div className="mono-sm" style={{ marginTop: 4 }}>
                    {plan.enabling.join(', ')}
                  </div>
                </div>
              </div>
            ) : null}

            {plan.reformats ? (
              <div className="callout callout-warn">
                <span className="callout-icon">⚠</span>
                <div>
                  The file's current formatting differs from what this tool writes, so the
                  whole file will be re-indented in addition to the values below. The keys and
                  values themselves are unchanged apart from the listed ones.
                </div>
              </div>
            ) : null}

            <div className="bypass-diff">
              {(plan.kind === 'apply' ? plan.changes : plan.diff).map((change) => (
                <ChangeLine key={change.key} change={change} />
              ))}
            </div>

            <div className="row">
              <button type="button" className="btn btn-danger" onClick={() => setConfirmOpen(true)}>
                {plan.kind === 'apply'
                  ? `Write and restart ${target.pm2Name}`
                  : `Restore ${plan.backupId} and restart`}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setPlan(null);
                  setState(STATE.EDIT);
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowFile((v) => !v)}
              >
                {showFile ? 'hide resulting file' : 'view resulting file'}
              </button>
            </div>

            {showFile ? <pre className="logbox bypass-file">{plan.nextText}</pre> : null}
          </div>
        ) : null}

        {/* ----------------------------------------------- running / finished */}
        {state === STATE.RUNNING || state === STATE.FINISHED ? (
          <div className="stack">
            {outcome?.ok ? (
              <div className="callout callout-ok">
                <span className="callout-icon">✓</span>
                <div>
                  <strong>Applied — {outcome.summary}.</strong>
                  <div className="mono-sm" style={{ marginTop: 4 }}>
                    {target.pm2Name} is online (backup {outcome.backupId}).
                    {outcome.asserted === 'pm2'
                      ? ' Verified via pm2 only: no healthUrl is configured for this target.'
                      : ''}
                  </div>
                </div>
              </div>
            ) : null}

            {outcome && !outcome.ok ? (
              <div className="callout callout-danger">
                <span className="callout-icon">⛔</span>
                <div>
                  <strong>Failed.</strong>
                  <div style={{ marginTop: 4 }}>{outcome.message}</div>
                  <div className="mono-sm" style={{ marginTop: 6 }}>
                    {outcome.rolledBack
                      ? 'The previous bypass.json was restored and the process is back online.'
                      : outcome.configUntouched
                        ? 'The file was not changed.'
                        : `Check the log. The pre-change file is in the backups list${
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
                    resetAll();
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

      {/* --------------------------------------------------------- confirm */}
      {confirmOpen && plan ? (
        <div className="modal-backdrop" onClick={() => setConfirmOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>
                {plan.kind === 'apply' ? 'Confirm bypass change' : 'Confirm restore'}
              </span>
            </div>
            <div className="modal-body stack-sm">
              <div>
                This writes <span className="mono-sm">{target.configPath}</span> and then runs{' '}
                <span className="mono-sm">pm2 restart {target.pm2Name}</span>. In-flight requests
                to the backend will be dropped by the restart.
              </div>

              <div className="bypass-diff">
                {(plan.kind === 'apply' ? plan.changes : plan.diff).map((change) => (
                  <ChangeLine key={change.key} change={change} />
                ))}
              </div>

              {plan.kind === 'apply' && plan.enabling?.length ? (
                <div className="callout callout-warn">
                  <span className="callout-icon">⚠</span>
                  <div>
                    Enabling a bypass turns a check off in UAT: {plan.enabling.join(', ')}
                  </div>
                </div>
              ) : null}

              <div className="faint mono-sm">
                If {target.pm2Name} does not come back online, the previous file is restored
                automatically and the process is restarted again.
              </div>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={run}>
                Write and restart
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
