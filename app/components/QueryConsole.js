'use client';

/**
 * QueryConsole — the Query screen.
 *
 * Flow:
 *   type  → the badge classifies the statement as you go (query-guard, shared
 *           with the server so the two cannot disagree)
 *   Run   → a read executes; anything that writes goes to /preview first
 *   modal → shows the rows that will actually change, then confirms
 *
 * The badge is a convenience. The server re-analyses every statement and holds
 * the confirm token, so a client that lies about a verdict gains nothing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { sql as sqlLang } from '@codemirror/lang-sql';
import { statementBadge } from '@/lib/query-guard';
import ResultsGrid from './ResultsGrid';
import TableBrowser from './TableBrowser';
import RowEditorDrawer from './RowEditorDrawer';

// CodeMirror touches the DOM on import, so it must not be server-rendered.
const CodeMirror = dynamic(() => import('@uiw/react-codemirror'), {
  ssr: false,
  loading: () => <div className="editor-loading mono-sm faint">loading editor…</div>,
});

const STARTER_SQL = 'SELECT * FROM CUSTID_DETAILS LIMIT 20';

export default function QueryConsole() {
  const [sqlText, setSqlText] = useState(STARTER_SQL);
  const [tree, setTree] = useState(null);
  const [treeError, setTreeError] = useState(null);

  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const [confirm, setConfirm] = useState(null); // preview payload awaiting confirmation
  const [typedConfirm, setTypedConfirm] = useState('');

  const [browseTable, setBrowseTable] = useState(null);
  const [editingRow, setEditingRow] = useState(null);

  const [saveName, setSaveName] = useState('');
  const [savingOpen, setSavingOpen] = useState(false);
  const [savedNotice, setSavedNotice] = useState(null);

  const editorRef = useRef(null);

  /* ---------------------------------------------------------- table tree */
  const loadTree = useCallback(async () => {
    try {
      const res = await fetch('/api/query/tables', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        setTreeError(data.error || `Could not load tables (HTTP ${res.status})`);
        return;
      }
      setTree(data);
      setTreeError(null);
    } catch (err) {
      setTreeError(err.message);
    }
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  /**
   * Pick up a query handed over from the Saved screen. It is only loaded into the
   * editor — never executed — so a saved DELETE still has to be previewed and
   * confirmed by whoever opened it.
   */
  useEffect(() => {
    try {
      const pending = sessionStorage.getItem('ubi-ops:pending-sql');
      if (pending) {
        setSqlText(pending);
        sessionStorage.removeItem('ubi-ops:pending-sql');
      }
    } catch {
      /* sessionStorage unavailable — nothing to restore */
    }
  }, []);

  /* --------------------------------------------------------- live badge */
  const badge = useMemo(() => statementBadge(sqlText), [sqlText]);
  const canRun = Boolean(sqlText.trim()) && !badge.blocked && !running;

  /* --------------------------------------------------------- run / confirm */

  async function executeConfirmed(sqlToRun, confirmToken) {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/query/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlToRun, confirmToken }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError({ message: data.error || `Failed (HTTP ${res.status})`, code: data.code });
        return;
      }
      setResult(data);
    } catch (err) {
      setError({ message: err.message });
    } finally {
      setRunning(false);
    }
  }

  async function run() {
    if (!canRun) return;

    setError(null);
    setResult(null);
    setTypedConfirm('');

    // A read needs no confirmation — execute straight away.
    if (!badge.requiresConfirmation) {
      await executeConfirmed(sqlText, undefined);
      return;
    }

    // Everything that writes: preview first, always.
    setRunning(true);
    try {
      const res = await fetch('/api/query/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: sqlText }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError({ message: data.error || `Preview failed (HTTP ${res.status})`, code: data.code });
        return;
      }
      setConfirm(data);
    } catch (err) {
      setError({ message: err.message });
    } finally {
      setRunning(false);
    }
  }

  async function confirmAndRun() {
    const pending = confirm;
    setConfirm(null);
    await executeConfirmed(pending.normalized || sqlText, pending.confirmToken);
    if (browseTable) refreshBrowse();
  }

  /* ----------------------------------------------------------- shortcuts */
  useEffect(() => {
    const onKey = (e) => {
      const isRun = (e.metaKey || e.ctrlKey) && e.key === 'Enter';
      if (isRun) {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /* ------------------------------------------------------ editor helpers */

  /** Insert a table name at the cursor, per §4.3. */
  function insertTable(name) {
    const view = editorRef.current?.view;
    if (!view) {
      setSqlText((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}${name}`);
      return;
    }
    const { from, to } = view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: name },
      selection: { anchor: from + name.length },
    });
    view.focus();
  }

  function refreshBrowse() {
    if (browseTable) doBrowse(browseTable);
  }

  async function doBrowse(name) {
    setBrowseTable(name);
    const statement = `SELECT * FROM ${name} LIMIT 50`;
    setSqlText(statement);
    setResult(null);
    setError(null);
    setRunning(true);
    try {
      const res = await fetch('/api/query/execute', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: statement }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError({ message: data.error || `Failed (HTTP ${res.status})`, code: data.code });
        return;
      }
      setResult(data);
    } catch (err) {
      setError({ message: err.message });
    } finally {
      setRunning(false);
    }
  }

  async function saveQuery() {
    if (!saveName.trim()) return;
    try {
      const res = await fetch('/api/saved', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: saveName.trim(), sql: sqlText }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError({ message: data.error || 'Could not save' });
        return;
      }
      setSavedNotice(`Saved as "${data.query.name}"`);
      setSaveName('');
      setSavingOpen(false);
      setTimeout(() => setSavedNotice(null), 4000);
    } catch (err) {
      setError({ message: err.message });
    }
  }

  const typedConfirmSatisfied =
    !confirm?.requiresTypedConfirmation ||
    typedConfirm === (confirm.typedConfirmationValue || confirm.table);

  return (
    <div className="console">
      <aside className="console-rail">
        {treeError ? (
          <div className="callout callout-danger" style={{ margin: 8 }}>
            <span className="callout-icon">⛔</span>
            <div className="mono-sm">{treeError}</div>
          </div>
        ) : null}
        {tree ? (
          <TableBrowser
            tree={tree}
            selectedTable={browseTable}
            onInsertTable={insertTable}
            onBrowseTable={doBrowse}
          />
        ) : (
          <div className="empty">loading tables…</div>
        )}
      </aside>

      <div className="console-main">
        {tree && tree.dbReachable === false ? (
          <div className="callout callout-danger" style={{ marginBottom: 10 }}>
            <span className="callout-icon">⛔</span>
            <div>
              Cannot reach the database at <strong>{tree.endpoint}</strong>. Queries will fail
              until the Oracle NoSQL proxy is reachable on that port.
            </div>
          </div>
        ) : null}

        <div className="panel">
          <div className="panel-head">
            <span>Query</span>
            <span className="topbar-spacer" />
            <span className="mono-sm faint">{tree?.endpoint}</span>
          </div>

          <div className="editor-wrap">
            <CodeMirror
              ref={editorRef}
              value={sqlText}
              height="180px"
              theme="dark"
              extensions={[sqlLang()]}
              onChange={setSqlText}
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLine: true,
                autocompletion: true,
              }}
            />
          </div>

          <div className="editor-bar">
            <button type="button" className="btn btn-primary" onClick={run} disabled={!canRun}>
              {running ? '…' : '▶ Run'}
            </button>

            {badge.label ? (
              <span
                className={`tag ${
                  badge.blocked
                    ? 'tag-danger'
                    : badge.risk === 'destructive'
                      ? 'tag-danger'
                      : badge.risk === 'write'
                        ? 'tag-warn'
                        : 'tag-ok'
                }`}
              >
                {badge.label}
              </span>
            ) : null}

            {badge.limitApplied ? (
              <span className="tag tag-accent">LIMIT {badge.effectiveLimit}</span>
            ) : null}

            {badge.requiresTypedConfirmation ? (
              <span className="tag tag-danger">irreversible</span>
            ) : null}

            <span className="topbar-spacer" />

            <span className="faint mono-sm">⌘/Ctrl + ↵</span>

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setSavingOpen((v) => !v)}
            >
              Save…
            </button>
          </div>

          {savingOpen ? (
            <div className="editor-bar">
              <input
                type="text"
                placeholder="name this query"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                style={{ maxWidth: 320 }}
              />
              <button type="button" className="btn btn-sm" onClick={saveQuery}>
                Save
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setSavingOpen(false)}
              >
                Cancel
              </button>
            </div>
          ) : null}

          {/* Blocked statements explain themselves at type-time, not after Run. */}
          {badge.blocked ? (
            <div className="editor-reason">
              <span className="callout-icon">⛔</span>
              <span>{badge.reason}</span>
            </div>
          ) : null}
        </div>

        {savedNotice ? (
          <div className="callout callout-ok" style={{ marginTop: 10 }}>
            <span className="callout-icon">✓</span>
            <div>{savedNotice}</div>
          </div>
        ) : null}

        {error ? (
          <div className="callout callout-danger" style={{ marginTop: 10 }}>
            <span className="callout-icon">⛔</span>
            <div>
              <strong>{error.code || 'Error'}</strong>
              <div style={{ marginTop: 4 }}>{error.message}</div>
            </div>
          </div>
        ) : null}

        {result?.ddl ? (
          <div className="callout callout-ok" style={{ marginTop: 10 }}>
            <span className="callout-icon">✓</span>
            <div>
              <strong>{result.type} completed</strong> in {result.elapsedMs} ms
              {result.tableState ? ` · table state: ${result.tableState}` : ''}
              {result.adminOutput ? (
                <pre className="logbox" style={{ marginTop: 8 }}>
                  {typeof result.adminOutput === 'string'
                    ? result.adminOutput
                    : JSON.stringify(result.adminOutput, null, 2)}
                </pre>
              ) : null}
            </div>
          </div>
        ) : null}

        {result && !result.ddl ? (
          <div style={{ marginTop: 10 }}>
            <ResultsGrid
              rows={result.rows}
              elapsedMs={result.elapsedMs}
              truncated={result.truncated}
              limitApplied={result.limitApplied}
              effectiveLimit={result.effectiveLimit}
              selectable
              onSelectRow={(row) => setEditingRow(row)}
              emptyMessage={
                result.type === 'SELECT' ? 'no rows matched' : `${result.type} affected 0 rows`
              }
            />
          </div>
        ) : null}
      </div>

      {/* ------------------------------------------------- confirm modal */}
      {confirm ? (
        <div className="modal-backdrop" onClick={() => setConfirm(null)}>
          <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>⚠</span>
              <span>
                This will {confirm.type}
                {confirm.table ? ` in ${confirm.table}` : ''}
              </span>
            </div>

            <div className="modal-body">
              {confirm.rows ? (
                <>
                  <div
                    className={`callout ${
                      confirm.atCap || confirm.rowCount > 50 ? 'callout-danger' : 'callout-warn'
                    }`}
                  >
                    <span className="callout-icon">⚠</span>
                    <div>
                      <strong>
                        {confirm.countLabel} row{confirm.countLabel === '1' ? '' : 's'} will be{' '}
                        {confirm.type === 'DELETE' ? 'deleted from' : 'changed in'}{' '}
                        {confirm.table}
                      </strong>
                      {confirm.atCap ? (
                        <div style={{ marginTop: 4 }}>
                          The preview stops at 500 rows — the real number may be far higher.
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <ResultsGrid
                    rows={confirm.rows}
                    elapsedMs={confirm.elapsedMs}
                    emptyMessage="no rows matched — nothing would change"
                  />
                </>
              ) : (
                <div className="callout callout-danger">
                  <span className="callout-icon">⛔</span>
                  <div>{confirm.previewNote || 'This statement cannot be previewed.'}</div>
                </div>
              )}

              <dl className="kv">
                <dt>statement</dt>
                <dd>{confirm.normalized}</dd>
                {confirm.where ? (
                  <>
                    <dt>where</dt>
                    <dd>{confirm.where}</dd>
                  </>
                ) : null}
                <dt>channel</dt>
                <dd>{confirm.channel}</dd>
              </dl>

              {confirm.requiresTypedConfirmation ? (
                <div className="stack-sm">
                  <label className="rail-label" htmlFor="typed-confirm">
                    type <strong>{confirm.typedConfirmationValue || confirm.table}</strong> to
                    confirm
                  </label>
                  <input
                    id="typed-confirm"
                    type="text"
                    value={typedConfirm}
                    onChange={(e) => setTypedConfirm(e.target.value)}
                    autoComplete="off"
                  />
                </div>
              ) : null}
            </div>

            <div className="modal-foot">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={!typedConfirmSatisfied}
                onClick={confirmAndRun}
              >
                Confirm {confirm.type}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <RowEditorDrawer
        open={Boolean(editingRow)}
        table={browseTable || result?.verdictTable || inferTable(sqlText)}
        row={editingRow}
        onClose={() => setEditingRow(null)}
        onChanged={() => {
          setEditingRow(null);
          refreshBrowse();
        }}
      />
    </div>
  );
}

/**
 * Best-effort table name for the row editor when the user ran a hand-written
 * SELECT rather than clicking "browse". Only used to pre-fill; the server still
 * validates the table and the key.
 */
function inferTable(sqlText) {
  const match = /\bFROM\s+([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*)/i.exec(
    sqlText || ''
  );
  return match ? match[1] : null;
}
