'use client';

/**
 * OpsConsole — the everyday tasks, without writing SQL.
 *
 * Layout is deliberately flat: one toolbar, one aligned table, one dialog.
 *
 * Two things this screen learned the hard way:
 *
 *   - Repeating the field name beside every value on every row (`custId UBI123
 *     applicant_name …`) meant nothing lined up between rows, so scanning a
 *     result set was reading rather than glancing. The names are now a single
 *     header and the values sit in fixed columns.
 *   - "Set application status" as a button that opened a dialog containing a
 *     dropdown was three clicks to change one field. The dropdown is now the
 *     control itself, on the row: pick a status and the only thing left is
 *     confirming what it will run.
 *
 * Every action still goes plan → preview → confirm through the same endpoints as
 * the Terminal, so a button here cannot do anything the guard would refuse, and
 * the affected-row count and the exact statement are always shown first.
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
  APPLICANTS_NEW_LOAN_CASES: ['custId', 'applicant_name', 'mobile_no'],
  CUSTID_DETAILS: ['custId', 'acc_no', 'mobile_no', 'state'],
  CLOGIN: ['userName', 'mobileNo', 'email', 'staffId'],
};

/**
 * Human column headings. The raw field name stays as the cell/heading tooltip,
 * because it is what you type into the search box and what appears in the SQL.
 */
const FIELD_LABELS = {
  custId: 'Customer ID',
  applicant_name: 'Applicant',
  mobile_no: 'Mobile',
  acc_no: 'Account no.',
  state: 'State',
  userName: 'Username',
  mobileNo: 'Mobile',
  email: 'Email',
  staffId: 'Staff ID',
  appStatus: 'Application status',
};

/** Column widths, so ids and phone numbers do not wobble between rows. */
const WIDTHS = {
  custId: '170px',
  applicant_name: 'minmax(140px, 1fr)',
  mobile_no: '110px',
  mobileNo: '110px',
  acc_no: '160px',
  state: '80px',
  userName: 'minmax(120px, 1fr)',
  email: 'minmax(160px, 1fr)',
  staffId: '100px',
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

  const [dialog, setDialog] = useState(null); // {action, row, param, label, plan, preview}
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

  const statusAction = actions.find((a) => a.action === 'set-app-status') || null;
  const pathAction = actions.find((a) => a.needsPath) || null;
  /**
   * Deleting a row gets its own button rather than an entry in a menu.
   * Everything else in that menu is recoverable — a status can be set back, a
   * cleared field can be re-fetched — and a delete is not, so it should not be
   * one line below "clear docs.assets.bhoomi" in the same list.
   */
  const deleteAction = actions.find((a) => a.action.startsWith('delete-')) || null;
  /** The rest: recoverable fixes, collected in one menu. */
  const menuActions = actions.filter(
    (a) => a !== statusAction && a !== deleteAction && !a.needsPath
  );
  const hasMenu = Boolean(pathAction || menuActions.length);

  /** The row's columns: fields, then the status dropdown, then the controls. */
  const columns = useMemo(() => {
    const cols = (SUMMARY_FIELDS[tableKey] || []).map((key) => ({
      key,
      kind: 'field',
      width: WIDTHS[key] || 'minmax(120px, 1fr)',
    }));
    if (statusAction) cols.push({ key: 'appStatus', kind: 'status', width: '250px' });
    // Fixed, not `auto`: an auto column is empty in the header row and holds
    // controls in the data rows, so the flexible column would absorb a different
    // amount of space in each and the header would not line up with the values.
    const width = 58 + (hasMenu ? 104 : 0) + (deleteAction ? 74 : 0);
    cols.push({ key: '__actions', kind: 'actions', width: `${width}px` });
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey, statusAction, deleteAction, hasMenu]);

  const template = columns.map((c) => c.width).join(' ');

  /**
   * Every action is opened with its parameter already chosen, so the dialog has
   * one job: show what will run, and take the confirmation.
   */
  function act(action, row, param, label) {
    setTyped('');
    const next = { action, row, param, label, plan: null, preview: null };
    setDialog(next);
    fetchPreview(next);
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

  /** A delete is worded and coloured differently from a recoverable change. */
  const isDelete = Boolean(dialog?.action?.action?.startsWith('delete-'));

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

  /** Status options for one row, including its own value if it is not a known one. */
  function statusOptions(current) {
    const known = config.statuses || [];
    if (!current || known.some((s) => s.value === current)) return known;
    // Never silently show a different status than the row actually holds.
    return [{ value: current, label: 'current value — not a known status' }, ...known];
  }

  return (
    <>
      {/* ----------------------------------------------------------- toolbar */}
      <div className="ops-bar">
        <label className="ops-label" htmlFor="ops-state">
          State
        </label>
        <select
          id="ops-state"
          value={state}
          onChange={(e) => setState(e.target.value)}
          title="Each state has its own tables — this picks which one you are looking at"
        >
          {config.states.map((s) => (
            <option key={s.group} value={s.group}>
              {s.group}
            </option>
          ))}
        </select>

        <label className="ops-label" htmlFor="ops-table">
          Records
        </label>
        <select
          id="ops-table"
          value={tableKey}
          onChange={(e) => setTableKey(e.target.value)}
          title="Which kind of record to work with"
        >
          {config.tableKeys.map((k) => (
            <option key={k} value={k}>
              {TABLE_LABELS[k] || k}
            </option>
          ))}
        </select>

        <span className="ops-bar-sep" />

        <label className="ops-label" htmlFor="ops-field">
          Find by
        </label>
        <select
          id="ops-field"
          value={field}
          onChange={(e) => setField(e.target.value)}
          title="Which field to match on"
        >
          {searchFields.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>

        <input
          id="ops-value"
          type="text"
          className="ops-bar-input"
          placeholder={`Type a ${field}, or leave blank to list every row`}
          value={value}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') load();
          }}
        />

        <button type="button" className="btn btn-primary" onClick={() => load()} disabled={busy}>
          {busy ? 'Searching…' : 'Search'}
        </button>
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
          <span>
            {result
              ? `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}${
                  result.rowCount === 50 ? ' (first 50)' : ''
                }`
              : '—'}
          </span>
          <span className="faint mono-sm" style={{ fontWeight: 400 }}>
            {physicalTable ? `in ${physicalTable}` : 'this table is not defined for this state'}
          </span>
          <span className="topbar-spacer" />
          {result ? <span className="mono-sm faint">{result.elapsedMs} ms</span> : null}
        </div>

        {!result || result.rowCount === 0 ? (
          <div className="empty">
            {busy ? (
              'Searching…'
            ) : value ? (
              <>
                No row where <span className="mono">{field}</span> is “{value}”.
                <div className="faint" style={{ marginTop: 5 }}>
                  Records are per state — check the State picker above if you expected one.
                </div>
              </>
            ) : (
              `No rows in ${physicalTable || 'this table'}.`
            )}
          </div>
        ) : (
          <div className="ops-table">
            <div className="ops-row ops-row-head" style={{ gridTemplateColumns: template }}>
              {columns.map((col) => (
                <span key={col.key} title={col.kind === 'actions' ? undefined : col.key}>
                  {col.kind === 'actions' ? '' : FIELD_LABELS[col.key] || col.key}
                </span>
              ))}
            </div>

            {result.rows.map((row, i) => (
              <div
                className="ops-row"
                key={row.id || i}
                style={{ gridTemplateColumns: template }}
              >
                {columns.map((col) => {
                  /* ------------------------------------------- a plain field */
                  if (col.kind === 'field') {
                    const cell = row[col.key];
                    return (
                      <span className="ops-cell" key={col.key} title={String(cell ?? '')}>
                        {cell === undefined || cell === null ? (
                          <span className="cell-null">—</span>
                        ) : (
                          String(cell)
                        )}
                      </span>
                    );
                  }

                  /* ------------------- the status, as the control it should be */
                  if (col.kind === 'status') {
                    return (
                      <select
                        key={col.key}
                        className="ops-status-select"
                        aria-label={`appStatus for ${row.custId || row.id}`}
                        value={row.appStatus ?? ''}
                        disabled={busy || !row.id}
                        onChange={(e) =>
                          act(statusAction, row, e.target.value, `appStatus → ${e.target.value}`)
                        }
                      >
                        {row.appStatus == null ? <option value="">— not set —</option> : null}
                        {statusOptions(row.appStatus).map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.value}
                          </option>
                        ))}
                      </select>
                    );
                  }

                  /* ------------------------------------------------- controls */
                  return (
                    <span className="ops-cell-actions" key={col.key}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        title="See the whole row as JSON"
                        onClick={() => setViewRow(row)}
                      >
                        View
                      </button>

                      {/* The recoverable fixes, in one menu. Choosing an entry
                          opens the same confirm dialog as everything else. */}
                      {hasMenu ? (
                        <select
                          className="ops-action-select"
                          aria-label={`Fixes for ${row.custId || row.id}`}
                          title="Clear a field, or run a fix on this row"
                          value=""
                          disabled={busy || !row.id}
                          onChange={(e) => {
                            const [name, param] = e.target.value.split('::');
                            e.target.value = ''; // a menu, not a value
                            if (name === pathAction?.action) {
                              act(pathAction, row, param, `Clear ${param}`);
                              return;
                            }
                            const chosen = menuActions.find((a) => a.action === name);
                            if (chosen) act(chosen, row, undefined, chosen.label);
                          }}
                        >
                          <option value="">Fix…</option>

                          {pathAction ? (
                            <optgroup label="Clear a field on this row">
                              {(config.nullablePaths || []).map((p) => (
                                <option
                                  key={p.path}
                                  value={`${pathAction.action}::${p.path}`}
                                >
                                  {p.label || p.path} → {p.clear}
                                </option>
                              ))}
                            </optgroup>
                          ) : null}

                          {menuActions.length ? (
                            <optgroup label="Start part of the journey again">
                              {menuActions.map((a) => (
                                <option key={a.action} value={a.action}>
                                  {a.label}
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                        </select>
                      ) : null}

                      {deleteAction ? (
                        <button
                          type="button"
                          className="btn btn-danger-ghost btn-sm"
                          disabled={busy || !row.id}
                          title={`${deleteAction.label} — cannot be undone`}
                          onClick={() => act(deleteAction, row, undefined, deleteAction.label)}
                        >
                          Delete
                        </button>
                      ) : null}
                    </span>
                  );
                })}
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
              <span>{dialog.label || dialog.action.label}</span>
              <span className="topbar-spacer" />
              <span className="faint mono-sm">{dialog.row.custId || dialog.row.id}</span>
            </div>

            <div className="modal-body stack-sm">
              {!dialog.plan ? (
                <div className="faint mono-sm">Working out what this would change…</div>
              ) : (
                <>
                  <div
                    className={`callout ${
                      dialog.action.destructive ? 'callout-danger' : 'callout-warn'
                    }`}
                  >
                    <span className="callout-icon">{isDelete ? '⛔' : '⚠'}</span>
                    <div>
                      <strong>{dialog.plan.summary}</strong>
                      <div style={{ marginTop: 4 }}>
                        {isDelete
                          ? 'The row will be gone. This cannot be undone from here.'
                          : 'Nothing has run yet — this happens when you confirm.'}
                      </div>
                      <div className="mono-sm faint" style={{ marginTop: 5 }}>
                        {dialog.plan.table} · matches {dialog.preview.countLabel ?? '?'} row(s)
                      </div>
                    </div>
                  </div>

                  <div className="faint mono-sm">The exact statement that will run:</div>
                  <pre className="logbox" style={{ maxHeight: 120 }}>
                    {dialog.plan.sql}
                  </pre>

                  {dialog.preview.requiresTypedConfirmation ? (
                    <div className="stack-sm">
                      <label className="rail-label" htmlFor="dlg-typed">
                        Type{' '}
                        <strong>
                          {dialog.preview.typedConfirmationValue || dialog.preview.table}
                        </strong>{' '}
                        below to enable the button
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
              <button
                type="button"
                className={dialog.action.destructive ? 'btn btn-danger' : 'btn btn-primary'}
                disabled={!dialog.plan || !typedOk || busy}
                onClick={confirm}
              >
                {isDelete
                  ? 'Delete permanently'
                  : dialog.action.destructive
                    ? 'Yes, run it'
                    : 'Apply change'}
              </button>
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
