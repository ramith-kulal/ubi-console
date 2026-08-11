'use client';

/**
 * OpsConsole — the everyday tasks, without writing SQL.
 *
 * Layout is deliberately flat: one toolbar, one list of rows, one dialog.
 *
 * An earlier version put the status and field-path pickers in permanent panels
 * above the results. They were only ever needed at the moment of acting, and they
 * pushed the actual data below the fold — so they now live inside the dialog, and
 * the screen is just "what did I find" plus "what do I want to do to this row".
 *
 * Every action still goes plan → preview → confirm through the same endpoints as
 * the Terminal, so a button cannot do anything the guard would refuse and you
 * always see the affected rows first.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import JsonDrawer from './JsonDrawer';

const TABLE_LABELS = {
  APPLICANTS_NEW_LOAN_CASES: 'New loan cases',
  CUSTID_DETAILS: 'CustID details',
  CLOGIN: 'Banker logins',
};

/** The few columns worth showing per row; everything else is behind "view". */
const SUMMARY_FIELDS = {
  APPLICANTS_NEW_LOAN_CASES: ['custId', 'applicant_name', 'mobile_no', 'appStatus'],
  CUSTID_DETAILS: ['custId', 'acc_no', 'mobile_no', 'state'],
  CLOGIN: ['userName', 'mobileNo', 'email', 'staffId'],
};

export default function OpsConsole() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);

  const [state, setState] = useState('KARNATAKA');
  const [tableKey, setTableKey] = useState('APPLICANTS_NEW_LOAN_CASES');
  const [field, setField] = useState('custId');
  const [value, setValue] = useState('');

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const [dialog, setDialog] = useState(null); // {action, row, param, plan, preview}
  const [typed, setTyped] = useState('');
  const [viewRow, setViewRow] = useState(null);

  /* ------------------------------------------------------------------ config */
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
      } catch (err) {
        setConfigError(err.message);
      }
    })();
  }, []);

  const searchFields = useMemo(() => config?.searchFields?.[tableKey] || [], [config, tableKey]);

  useEffect(() => {
    if (searchFields.length && !searchFields.includes(field)) setField(searchFields[0]);
  }, [searchFields, field]);

  const physicalTable = useMemo(() => {
    const s = config?.states?.find((x) => x.group === state);
    return s?.tables.find((t) => t.key === tableKey)?.table || null;
  }, [config, state, tableKey]);

  /* ------------------------------------------------------------------ search */
  const load = useCallback(
    async (filterValue) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch('/api/ops', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            kind: 'search',
            state,
            table: tableKey,
            field,
            value: filterValue ?? value,
            limit: 50,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error);
          setResult(null);
          return;
        }
        setResult(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
    },
    [state, tableKey, field, value]
  );

  // Open on the table's contents; look first, narrow second.
  useEffect(() => {
    if (config) load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, state, tableKey]);

  /* ------------------------------------------------------------------ actions */

  const actions = useMemo(
    () => (config?.actions || []).filter((a) => a.tableKey === tableKey),
    [config, tableKey]
  );

  function openDialog(action, row) {
    setTyped('');
    // Actions that need a choice open on that choice; the rest go straight to
    // fetching the preview.
    const needsChoice = action.needsPath || action.action === 'set-app-status';
    const param = action.needsPath
      ? config.nullablePaths?.[0]?.path
      : config.statuses?.[0]?.value;

    const next = { action, row, param, plan: null, preview: null };
    setDialog(next);
    if (!needsChoice) fetchPreview(next);
  }

  /** Ask the server to build the statement, then preview what it would change. */
  async function fetchPreview(current) {
    setBusy(true);
    setError(null);
    try {
      const planRes = await fetch('/api/ops', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'plan',
          action: current.action.action,
          state,
          id: current.row.id,
          status: current.action.action === 'set-app-status' ? current.param : undefined,
          path: current.action.needsPath ? current.param : undefined,
        }),
      });
      const plan = await planRes.json();
      if (!planRes.ok) {
        setError(plan.error);
        setDialog(null);
        return;
      }

      const prevRes = await fetch('/api/query/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: plan.sql }),
      });
      const preview = await prevRes.json();
      if (!prevRes.ok) {
        setError(preview.error);
        setDialog(null);
        return;
      }

      setDialog({ ...current, plan, preview });
    } catch (err) {
      setError(err.message);
      setDialog(null);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    const { plan, preview } = dialog;
    setDialog(null);
    setBusy(true);
    try {
      const res = await fetch('/api/query/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: plan.sql, confirmToken: preview.confirmToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error);
        return;
      }
      setNotice(plan.summary);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const typedOk =
    !dialog?.preview?.requiresTypedConfirmation ||
    typed === (dialog.preview.typedConfirmationValue || dialog.preview.table || '');

  if (configError) {
    return (
      <div className="callout callout-danger">
        <span className="callout-icon">⛔</span>
        <div>{configError}</div>
      </div>
    );
  }
  if (!config) {
    return (
      <div className="panel">
        <div className="empty">loading…</div>
      </div>
    );
  }

  const summaryFields = SUMMARY_FIELDS[tableKey] || [];

  return (
    <>
      {/* ----------------------------------------------------------- toolbar */}
      <div className="ops-bar">
        <select value={state} onChange={(e) => setState(e.target.value)} title="State">
          {config.states.map((s) => (
            <option key={s.group} value={s.group}>
              {s.group}
            </option>
          ))}
        </select>

        <select value={tableKey} onChange={(e) => setTableKey(e.target.value)} title="Table">
          {config.tableKeys.map((k) => (
            <option key={k} value={k}>
              {TABLE_LABELS[k] || k}
            </option>
          ))}
        </select>

        <select value={field} onChange={(e) => setField(e.target.value)} title="Search by">
          {searchFields.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>

        <input
          type="text"
          className="ops-bar-input"
          placeholder={`${field} — blank for all`}
          value={value}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load();
          }}
        />

        <button type="button" className="btn btn-primary" onClick={() => load()} disabled={busy}>
          {busy ? '…' : 'Search'}
        </button>

        <span className="topbar-spacer" />
        <span className="faint mono-sm">{physicalTable || 'not in this state'}</span>
      </div>

      {notice ? (
        <div className="callout callout-ok" style={{ marginTop: 10 }}>
          <span className="callout-icon">✓</span>
          <div>{notice}</div>
        </div>
      ) : null}

      {error ? (
        <div className="callout callout-danger" style={{ marginTop: 10 }}>
          <span className="callout-icon">⛔</span>
          <div>{error}</div>
        </div>
      ) : null}

      {/* -------------------------------------------------------------- rows */}
      <div className="panel" style={{ marginTop: 10 }}>
        <div className="panel-head">
          <span>{result ? `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}` : '—'}</span>
          <span className="topbar-spacer" />
          {result ? <span className="mono-sm muted">{result.elapsedMs} ms</span> : null}
        </div>

        {!result || result.rowCount === 0 ? (
          <div className="empty">{busy ? 'loading…' : 'nothing found'}</div>
        ) : (
          <div>
            {result.rows.map((row, i) => (
              <div className="ops-item" key={row.id || i}>
                <div className="ops-item-data">
                  {summaryFields.map((f) =>
                    row[f] === undefined || row[f] === null ? null : (
                      <span className="ops-kv" key={f}>
                        <span className="faint">{f}</span> {String(row[f])}
                      </span>
                    )
                  )}
                </div>

                <div className="ops-item-actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setViewRow(row)}
                  >
                    view
                  </button>
                  {actions.map((a) => (
                    <button
                      key={a.action}
                      type="button"
                      className={`btn btn-sm${a.destructive ? ' btn-danger' : ''}`}
                      disabled={busy || !row.id}
                      onClick={() => openDialog(a, row)}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------ dialog */}
      {dialog ? (
        <div className="modal-backdrop" onClick={() => setDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{dialog.action.destructive ? '⚠' : '✎'}</span>
              <span>{dialog.action.label}</span>
              <span className="topbar-spacer" />
              <span className="faint mono-sm">{dialog.row.custId || dialog.row.id}</span>
            </div>

            <div className="modal-body">
              {/* step 1: the choice this action needs */}
              {!dialog.plan ? (
                <>
                  {dialog.action.action === 'set-app-status' ? (
                    <div className="stack-sm">
                      <label className="rail-label" htmlFor="dlg-status">new appStatus</label>
                      <select
                        id="dlg-status"
                        value={dialog.param}
                        onChange={(e) => setDialog({ ...dialog, param: e.target.value })}
                      >
                        {config.statuses.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.value} — {s.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  {dialog.action.needsPath ? (
                    <div className="stack-sm">
                      <label className="rail-label" htmlFor="dlg-path">field to clear</label>
                      <select
                        id="dlg-path"
                        value={dialog.param}
                        onChange={(e) => setDialog({ ...dialog, param: e.target.value })}
                      >
                        {(config.nullablePaths || []).map((p) => (
                          <option key={p.path} value={p.path}>
                            {p.path} → {p.clear}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  {busy ? <div className="faint mono-sm">building…</div> : null}
                </>
              ) : (
                /* step 2: what it will actually do */
                <>
                  <div
                    className={`callout ${
                      dialog.action.destructive ? 'callout-danger' : 'callout-warn'
                    }`}
                  >
                    <span className="callout-icon">⚠</span>
                    <div>
                      <strong>{dialog.plan.summary}</strong>
                      <div className="mono-sm" style={{ marginTop: 4 }}>
                        {dialog.plan.table}
                      </div>
                    </div>
                  </div>

                  <div className="faint mono-sm">
                    {dialog.preview.countLabel ?? '?'} row(s) matched
                  </div>

                  <pre className="logbox" style={{ maxHeight: 120 }}>
                    {dialog.plan.sql}
                  </pre>

                  {dialog.preview.requiresTypedConfirmation ? (
                    <div className="stack-sm">
                      <label className="rail-label" htmlFor="dlg-typed">
                        type{' '}
                        <strong>
                          {dialog.preview.typedConfirmationValue || dialog.preview.table}
                        </strong>{' '}
                        to confirm
                      </label>
                      <input
                        id="dlg-typed"
                        type="text"
                        autoComplete="off"
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                      />
                    </div>
                  ) : null}
                </>
              )}
            </div>

            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setDialog(null)}>
                Cancel
              </button>
              {!dialog.plan ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => fetchPreview(dialog)}
                >
                  Preview
                </button>
              ) : (
                <button
                  type="button"
                  className={dialog.action.destructive ? 'btn btn-danger' : 'btn btn-primary'}
                  disabled={!typedOk || busy}
                  onClick={confirm}
                >
                  Confirm
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <JsonDrawer
        open={Boolean(viewRow)}
        title={viewRow ? `${physicalTable} · ${viewRow.custId || viewRow.id}` : ''}
        value={viewRow}
        onClose={() => setViewRow(null)}
      />
    </>
  );
}
