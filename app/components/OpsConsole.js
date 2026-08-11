'use client';

/**
 * OpsConsole — the everyday tasks, without writing SQL.
 *
 * Pick a state, search the three tables that matter, then act on a row: set the
 * application status, clear the bhoomi / satSure document paths, or delete the
 * row. Each button asks the server to *build* the statement, then runs it through
 * the same preview → confirm → execute path as the Terminal. That means an ops
 * button cannot do anything the guard would refuse, and you always see the
 * affected rows before anything changes.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import ResultsGrid from './ResultsGrid';

const TABLE_LABELS = {
  APPLICANTS_NEW_LOAN_CASES: 'New loan cases',
  CUSTID_DETAILS: 'CustID details',
  CLOGIN: 'Banker logins (CLOGIN)',
};

/** Actions offered for the table currently being browsed. */
function actionsFor(tableKey, actions) {
  return actions.filter((a) => a.tableKey === tableKey);
}

export default function OpsConsole() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);

  const [state, setState] = useState('KARNATAKA');
  const [tableKey, setTableKey] = useState('APPLICANTS_NEW_LOAN_CASES');
  const [field, setField] = useState('custId');
  const [value, setValue] = useState('');

  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [pending, setPending] = useState(null); // {plan, preview}
  const [typedConfirm, setTypedConfirm] = useState('');
  const [statusChoice, setStatusChoice] = useState('');
  const [pathChoice, setPathChoice] = useState('');
  const [busy, setBusy] = useState(false);

  /* ------------------------------------------------------------- config */
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/ops', { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) {
          setConfigError(data.error || `Could not load config (HTTP ${res.status})`);
          return;
        }
        setConfig(data);
        if (data.statuses?.length) setStatusChoice(data.statuses[0].value);
        if (data.nullablePaths?.length) setPathChoice(data.nullablePaths[0].path);
      } catch (err) {
        setConfigError(err.message);
      }
    })();
  }, []);

  const searchFields = useMemo(
    () => (config?.searchFields?.[tableKey] || []),
    [config, tableKey]
  );

  // Keep the field valid when the table changes.
  useEffect(() => {
    if (searchFields.length && !searchFields.includes(field)) setField(searchFields[0]);
  }, [searchFields, field]);

  const physicalTable = useMemo(() => {
    const s = config?.states?.find((x) => x.group === state);
    return s?.tables.find((t) => t.key === tableKey)?.table || null;
  }, [config, state, tableKey]);

  /* ------------------------------------------------------------- search */
  const runSearch = useCallback(
    async (overrides = {}) => {
      const payload = {
        kind: 'search',
        state: overrides.state ?? state,
        table: overrides.table ?? tableKey,
        field: overrides.field ?? field,
        value: overrides.value ?? value,
        limit: 50,
      };
      setSearching(true);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch('/api/ops', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          setError({ message: data.error, code: data.code });
          setResult(null);
          return;
        }
        setResult(data);
      } catch (err) {
        setError({ message: err.message });
      } finally {
        setSearching(false);
      }
    },
    [state, tableKey, field, value]
  );

  /**
   * Load the table's contents as soon as the screen (or the state / table
   * selection) is ready, with no filter. The team looks first and narrows second,
   * so opening on an empty box would just mean an extra click every time.
   *
   * Deliberately keyed on state+table only: re-running on every keystroke in the
   * value box would fire a query per character.
   */
  useEffect(() => {
    if (!config) return;
    runSearch({ value: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, state, tableKey]);

  /* --------------------------------------------------- action: plan+preview */

  /**
   * Ask the server to build the statement, then preview it. Two round trips on
   * purpose: the plan is server-authored, and the preview shows the rows that
   * will actually change before any confirmation is offered.
   */
  async function startAction(actionName, row) {
    setError(null);
    setNotice(null);
    setTypedConfirm('');
    setBusy(true);

    try {
      const planRes = await fetch('/api/ops', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'plan',
          action: actionName,
          state,
          id: row.id,
          status: statusChoice,
          path: pathChoice,
        }),
      });
      const plan = await planRes.json();
      if (!planRes.ok) {
        setError({ message: plan.error, code: plan.code });
        return;
      }

      const prevRes = await fetch('/api/query/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: plan.sql }),
      });
      const preview = await prevRes.json();
      if (!prevRes.ok) {
        setError({ message: preview.error, code: preview.code });
        return;
      }

      setPending({ plan, preview, row });
    } catch (err) {
      setError({ message: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function confirmAction() {
    if (!pending) return;
    const { plan, preview } = pending;
    setPending(null);
    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/query/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: plan.sql, confirmToken: preview.confirmToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError({ message: data.error, code: data.code });
        return;
      }
      setNotice(`${plan.label} — done (${data.elapsedMs} ms).`);
      // Re-run the search so the grid reflects reality rather than what it
      // showed before the write.
      await runSearch();
    } catch (err) {
      setError({ message: err.message });
    } finally {
      setBusy(false);
    }
  }

  const typedOk =
    !pending?.preview?.requiresTypedConfirmation ||
    typedConfirm ===
      (pending.preview.typedConfirmationValue || pending.preview.table || '');

  if (configError) {
    return (
      <div className="callout callout-danger">
        <span className="callout-icon">⛔</span>
        <div>{configError}</div>
      </div>
    );
  }

  if (!config) return <div className="panel"><div className="empty">loading…</div></div>;

  const rowActions = actionsFor(tableKey, config.actions);

  return (
    <div className="stack">
      {/* ------------------------------------------------------- search bar */}
      <div className="panel">
        <div className="panel-head">
          <span>Find a record</span>
          <span className="topbar-spacer" />
          {physicalTable ? (
            <span className="tag tag-accent" title="Physical table for this state">
              {physicalTable}
            </span>
          ) : (
            <span className="tag tag-warn">table not defined for this state</span>
          )}
        </div>

        <div className="panel-body">
          <div className="ops-search">
            <div className="ops-field">
              <label className="rail-label" htmlFor="ops-state">state</label>
              <select id="ops-state" value={state} onChange={(e) => setState(e.target.value)}>
                {config.states.map((s) => (
                  <option key={s.group} value={s.group}>
                    {s.group}
                    {s.stateCode ? ` (${s.stateCode})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="ops-field">
              <label className="rail-label" htmlFor="ops-table">table</label>
              <select id="ops-table" value={tableKey} onChange={(e) => setTableKey(e.target.value)}>
                {config.tableKeys.map((key) => (
                  <option key={key} value={key}>
                    {TABLE_LABELS[key] || key}
                  </option>
                ))}
              </select>
            </div>

            <div className="ops-field">
              <label className="rail-label" htmlFor="ops-field">search by</label>
              <select id="ops-field" value={field} onChange={(e) => setField(e.target.value)}>
                {searchFields.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>

            <div className="ops-field ops-field-grow">
              <label className="rail-label" htmlFor="ops-value">value</label>
              <input
                id="ops-value"
                type="text"
                placeholder={`${field}…`}
                value={value}
                autoComplete="off"
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') runSearch();
                }}
              />
            </div>

            <button
              type="button"
              className="btn btn-primary"
              onClick={() => runSearch()}
              disabled={searching}
            >
              {searching ? '…' : value.trim() ? 'Search' : 'Reload'}
            </button>
          </div>

          {result?.sql ? (
            <div className="faint mono-sm" style={{ marginTop: 9 }}>
              {result.sql}
            </div>
          ) : null}
        </div>
      </div>

      {notice ? (
        <div className="callout callout-ok">
          <span className="callout-icon">✓</span>
          <div>{notice}</div>
        </div>
      ) : null}

      {error ? (
        <div className="callout callout-danger">
          <span className="callout-icon">⛔</span>
          <div>
            <strong>{error.code || 'Error'}</strong>
            <div style={{ marginTop: 4 }}>{error.message}</div>
          </div>
        </div>
      ) : null}

      {/* ------------------------------------------------- status selector */}
      {tableKey === 'APPLICANTS_NEW_LOAN_CASES' ? (
        <div className="panel">
          <div className="panel-head">
            <span>Application status to set</span>
            <span className="topbar-spacer" />
            <span className="faint mono-sm">used by the status actions below</span>
          </div>
          <div className="panel-body">
            <div className="ops-search">
              <div className="ops-field ops-field-grow">
                <label className="rail-label" htmlFor="ops-status">appStatus</label>
                <select
                  id="ops-status"
                  value={statusChoice}
                  onChange={(e) => setStatusChoice(e.target.value)}
                >
                  {config.statuses.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.value} — {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="faint mono-sm" style={{ marginTop: 8 }}>
              {config.statuses.length} values, generated from ubi-backend
              APP_JOURNEY_STATUS. Anything outside this list has to go through the
              Terminal.
            </div>

            <div className="ops-search" style={{ marginTop: 12 }}>
              <div className="ops-field ops-field-grow">
                <label className="rail-label" htmlFor="ops-path">
                  field to clear / null
                </label>
                <select
                  id="ops-path"
                  value={pathChoice}
                  onChange={(e) => setPathChoice(e.target.value)}
                >
                  {(config.nullablePaths || []).map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.label} → {p.clear}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="faint mono-sm" style={{ marginTop: 6 }}>
              Used by “Clear / null a field”. File arrays are set to [] and whole
              objects to null, matching how the application checks them.
            </div>
          </div>
        </div>
      ) : null}

      {/* --------------------------------------------------------- results */}
      {result ? (
        <div className="panel">
          <div className="panel-head">
            <span>
              {result.rowCount} match{result.rowCount === 1 ? '' : 'es'} in {result.table}
            </span>
            <span className="topbar-spacer" />
            <span className="mono-sm muted">{result.elapsedMs} ms</span>
          </div>

          {result.rowCount === 0 ? (
            <div className="empty">nothing matched</div>
          ) : (
            <div className="ops-rows">
              {result.rows.map((row, index) => (
                <div className="ops-row" key={row.id || index}>
                  <div className="ops-row-head">
                    <span className="mono-sm">
                      {row.custId ? `custId ${row.custId}` : `row ${index + 1}`}
                    </span>
                    {row.appStatus ? (
                      <span className="tag tag-accent">appStatus: {row.appStatus}</span>
                    ) : null}
                    {row.state ? <span className="tag">{row.state}</span> : null}
                    <span className="topbar-spacer" />
                    <span className="faint mono-sm">id {row.id}</span>
                  </div>

                  <div className="ops-row-actions">
                    {rowActions.map((action) => (
                      <button
                        key={action.action}
                        type="button"
                        className={`btn btn-sm${action.destructive ? ' btn-danger' : ''}`}
                        disabled={busy || !row.id}
                        title={
                          row.id
                            ? undefined
                            : 'This row has no id, so it cannot be targeted safely'
                        }
                        onClick={() => startAction(action.action, row)}
                      >
                        {action.needsPath ? `Clear ${pathChoice}` : action.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              <ResultsGrid
                rows={result.rows}
                elapsedMs={result.elapsedMs}
                emptyMessage="nothing matched"
              />
            </div>
          )}
        </div>
      ) : null}

      {/* --------------------------------------------------- confirm modal */}
      {pending ? (
        <div className="modal-backdrop" onClick={() => setPending(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>⚠</span>
              <span>{pending.plan.label}</span>
            </div>

            <div className="modal-body">
              <div
                className={`callout ${
                  pending.plan.destructive ? 'callout-danger' : 'callout-warn'
                }`}
              >
                <span className="callout-icon">⚠</span>
                <div>
                  <strong>{pending.plan.summary}</strong>
                  <div style={{ marginTop: 4 }}>
                    in <strong>{pending.plan.table}</strong> ({state})
                  </div>
                </div>
              </div>

              {pending.preview.rows ? (
                <>
                  <div className="faint mono-sm">
                    {pending.preview.countLabel} row(s) matched — this is exactly what
                    will change:
                  </div>
                  <ResultsGrid
                    rows={pending.preview.rows}
                    emptyMessage="no rows matched — nothing would change"
                  />
                </>
              ) : (
                <div className="callout callout-info">
                  <span className="callout-icon">ℹ</span>
                  <div>{pending.preview.previewNote || 'No preview available.'}</div>
                </div>
              )}

              <dl className="kv">
                <dt>statement</dt>
                <dd>{pending.plan.sql}</dd>
              </dl>

              {pending.preview.requiresTypedConfirmation ? (
                <div className="stack-sm">
                  <label className="rail-label" htmlFor="ops-typed">
                    type{' '}
                    <strong>
                      {pending.preview.typedConfirmationValue || pending.preview.table}
                    </strong>{' '}
                    to confirm
                  </label>
                  <input
                    id="ops-typed"
                    type="text"
                    autoComplete="off"
                    value={typedConfirm}
                    onChange={(e) => setTypedConfirm(e.target.value)}
                  />
                </div>
              ) : null}
            </div>

            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button
                type="button"
                className={pending.plan.destructive ? 'btn btn-danger' : 'btn btn-primary'}
                disabled={!typedOk || busy}
                onClick={confirmAction}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
