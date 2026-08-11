'use client';

/**
 * RowEditorDrawer — view, edit or delete a single row by its primary key.
 *
 * This exists because it is safer than SQL text for the operation people
 * actually perform most: fixing or removing one applicant / custid record. The
 * primary key comes from the database, the write goes through the driver's
 * put/delete, and there is no clause to mistype.
 *
 * Two things it deliberately refuses to do:
 *  - guess the primary key (the server rejects a partial one)
 *  - let a primary key column be edited, which would create a second row and
 *    leave the original behind — an "edit" that silently duplicates
 */

import { useEffect, useMemo, useState } from 'react';

function isScalar(value) {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

export default function RowEditorDrawer({ open, table, row, onClose, onChanged }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loaded, setLoaded] = useState(null); // server response for this key
  const [draft, setDraft] = useState({}); // scalar field edits
  const [jsonDraft, setJsonDraft] = useState(''); // whole-row JSON edit
  const [mode, setMode] = useState('fields'); // 'fields' | 'json'
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typedConfirm, setTypedConfirm] = useState('');

  /* Fetch the authoritative row + tokens whenever the drawer opens. */
  useEffect(() => {
    if (!open || !table || !row) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotice(null);
    setLoaded(null);
    setConfirmDelete(false);
    setTypedConfirm('');

    (async () => {
      try {
        // The primary key columns come from the server; we send the whole row and
        // let it pick out the key it needs.
        const res = await fetch('/api/row', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'preview', table, key: pickKeyCandidates(row) }),
        });
        const data = await res.json();
        if (cancelled) return;

        if (!res.ok) {
          setError(data.error || `Could not load the row (HTTP ${res.status})`);
          return;
        }
        if (!data.found) {
          setError('This row no longer exists in the table.');
          setLoaded(data);
          return;
        }

        setLoaded(data);
        setDraft({ ...data.row });
        setJsonDraft(JSON.stringify(data.row, null, 2));
      } catch (err) {
        if (!cancelled) setError(err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, table, row]);

  /**
   * We do not know the primary key columns before asking, so send every scalar
   * field from the grid row and let the server select the ones it needs. Sending
   * nested objects would be pointless — a key column is never a JSON blob.
   */
  function pickKeyCandidates(source) {
    const out = {};
    for (const [k, v] of Object.entries(source || {})) {
      if (isScalar(v) && v !== null && v !== undefined && v !== '') out[k] = v;
    }
    return out;
  }

  const primaryKey = loaded?.primaryKey || [];
  const key = loaded?.key || {};

  const scalarFields = useMemo(() => {
    if (!loaded?.row) return [];
    return Object.keys(loaded.row).filter((k) => isScalar(loaded.row[k]));
  }, [loaded]);

  const nestedFields = useMemo(() => {
    if (!loaded?.row) return [];
    return Object.keys(loaded.row).filter((k) => !isScalar(loaded.row[k]));
  }, [loaded]);

  async function save() {
    setError(null);
    setNotice(null);

    let payloadRow;
    if (mode === 'json') {
      try {
        payloadRow = JSON.parse(jsonDraft);
      } catch (err) {
        setError(`The JSON is not valid: ${err.message}`);
        return;
      }
      if (!payloadRow || typeof payloadRow !== 'object' || Array.isArray(payloadRow)) {
        setError('The row must be a JSON object.');
        return;
      }
    } else {
      // Merge scalar edits over the loaded row so nested structures survive
      // untouched — a put() replaces the whole row, so anything dropped is lost.
      payloadRow = { ...loaded.row, ...draft };
    }

    setLoading(true);
    try {
      const res = await fetch('/api/row', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          table,
          key,
          row: payloadRow,
          confirmToken: loaded.updateToken,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Update failed (HTTP ${res.status})`);
        return;
      }
      setNotice('Row updated.');
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function remove() {
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await fetch('/api/row', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ table, key, confirmToken: loaded.deleteToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Delete failed (HTTP ${res.status})`);
        return;
      }
      setNotice('Row deleted.');
      setConfirmDelete(false);
      if (onChanged) onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer drawer-wide">
        <div className="drawer-head">
          <span className="mono-sm">
            {table}
            {primaryKey.length ? ` · key(${primaryKey.join(', ')})` : ''}
          </span>
          <span className="topbar-spacer" />
          <div className="tabs">
            <button
              type="button"
              className={`tab${mode === 'fields' ? ' active' : ''}`}
              onClick={() => setMode('fields')}
            >
              Fields
            </button>
            <button
              type="button"
              className={`tab${mode === 'json' ? ' active' : ''}`}
              onClick={() => setMode('json')}
            >
              JSON
            </button>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            close
          </button>
        </div>

        <div className="drawer-body-pad">
          {loading ? <div className="muted mono-sm">working…</div> : null}

          {error ? (
            <div className="callout callout-danger">
              <span className="callout-icon">⛔</span>
              <div>{error}</div>
            </div>
          ) : null}

          {notice ? (
            <div className="callout callout-ok">
              <span className="callout-icon">✓</span>
              <div>{notice}</div>
            </div>
          ) : null}

          {loaded?.found ? (
            <>
              <div className="callout callout-info">
                <span className="callout-icon">ℹ</span>
                <div>
                  Saving writes the <strong>whole row</strong> back (the driver&apos;s put
                  replaces it). Primary key columns cannot be changed here.
                </div>
              </div>

              {mode === 'fields' ? (
                <div className="field-list">
                  {scalarFields.map((field) => {
                    const isKey = primaryKey.includes(field);
                    return (
                      <div className="field-row" key={field}>
                        <label className="field-label" htmlFor={`f-${field}`}>
                          {field}
                          {isKey ? <span className="tag tag-accent">key</span> : null}
                        </label>
                        <input
                          id={`f-${field}`}
                          type="text"
                          value={draft[field] === null || draft[field] === undefined ? '' : String(draft[field])}
                          disabled={isKey}
                          onChange={(e) =>
                            setDraft((prev) => ({ ...prev, [field]: e.target.value }))
                          }
                        />
                      </div>
                    );
                  })}

                  {nestedFields.length ? (
                    <div className="field-nested-note faint mono-sm">
                      {nestedFields.length} nested field
                      {nestedFields.length === 1 ? '' : 's'} ({nestedFields.join(', ')}) are not
                      editable here — switch to the JSON tab to change them.
                    </div>
                  ) : null}
                </div>
              ) : (
                <textarea
                  className="json-editor"
                  spellCheck={false}
                  value={jsonDraft}
                  onChange={(e) => setJsonDraft(e.target.value)}
                />
              )}

              <div className="row" style={{ marginTop: 12 }}>
                <button type="button" className="btn btn-primary" onClick={save} disabled={loading}>
                  Save row
                </button>
                <span className="topbar-spacer" />
                {confirmDelete ? (
                  <>
                    <input
                      type="text"
                      style={{ width: 220 }}
                      placeholder={`type ${table} to confirm`}
                      value={typedConfirm}
                      onChange={(e) => setTypedConfirm(e.target.value)}
                    />
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={typedConfirm !== table || loading}
                      onClick={remove}
                    >
                      Confirm delete
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => setConfirmDelete(true)}
                    disabled={loading}
                  >
                    Delete row
                  </button>
                )}
              </div>
            </>
          ) : null}
        </div>
      </aside>
    </>
  );
}
