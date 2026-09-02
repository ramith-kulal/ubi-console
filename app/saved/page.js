'use client';

/**
 * Saved queries.
 *
 * Opening one LOADS it into the editor. It never executes. There is deliberately
 * no one-click path from this list to a destructive statement — whoever runs it
 * still goes through preview and confirmation on the Terminal screen.
 *
 * Deleting a saved query asks first. It is not a database write, so it does not
 * go through the confirm-token path, but it is still someone else's work being
 * thrown away by a button that sits next to the one you actually wanted — and
 * this list has no undo.
 */

import { Fragment, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

/** One line of plain English per risk class, for the tag's tooltip. */
const RISK_HINT = {
  destructive: 'Deletes or drops something. Needs a typed confirmation on the Terminal.',
  write: 'Changes rows. Previewed and confirmed before it runs.',
  read: 'Reads only.',
};

export default function SavedPage() {
  const router = useRouter();
  const [queries, setQueries] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/saved', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Could not load the saved queries (HTTP ${res.status})`);
        return;
      }
      setQueries(data.queries);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function remove(id) {
    setBusy(true);
    try {
      const res = await fetch(`/api/saved?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Could not delete that query');
        return;
      }
      setConfirming(null);
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  /** Hand the text to the Terminal screen; it does not run. */
  function openInTerminal(query) {
    try {
      sessionStorage.setItem('ubi-ops:pending-sql', query.sql);
    } catch {
      /* sessionStorage unavailable — the user can still copy the text */
    }
    router.push('/terminal');
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Saved</h1>
        <span className="page-sub">
          opening a query puts it in the editor — nothing here runs on its own
        </span>
      </div>

      {error ? (
        <div className="callout callout-danger" style={{ marginBottom: 12 }}>
          <span className="callout-icon">⛔</span>
          <div>{error}</div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <span>
            {queries === null
              ? 'Saved queries'
              : `${queries.length} saved quer${queries.length === 1 ? 'y' : 'ies'}`}
          </span>
          <span className="faint" style={{ fontWeight: 400 }}>
            click a name to see its SQL
          </span>
          <span className="topbar-spacer" />
        </div>

        {queries === null ? (
          <div className="empty">Loading…</div>
        ) : queries.length === 0 ? (
          <div className="empty">
            Nothing saved yet.
            <div className="faint" style={{ marginTop: 5 }}>
              Write a statement on the Terminal screen and use “Save…” to keep it here.
            </div>
          </div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ width: 120 }}>Statement</th>
                <th style={{ width: 130 }}>Saved by</th>
                <th style={{ width: 150 }}>When</th>
                <th style={{ width: 230 }} />
              </tr>
            </thead>
            <tbody>
              {queries.map((query) => {
                const open = expanded === query.id;
                return (
                  <Fragment key={query.id}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          className="row-expand"
                          title={open ? 'Hide the SQL' : 'Show the SQL'}
                          onClick={() => setExpanded(open ? null : query.id)}
                        >
                          <span className="faint">{open ? '▾' : '▸'}</span> {query.name}
                        </button>
                      </td>
                      <td>
                        {query.blocked ? (
                          <span
                            className="tag tag-danger"
                            title="The guard would refuse this statement as saved."
                          >
                            blocked
                          </span>
                        ) : (
                          <span
                            className={`tag ${
                              query.risk === 'destructive'
                                ? 'tag-danger'
                                : query.risk === 'write'
                                  ? 'tag-warn'
                                  : 'tag-ok'
                            }`}
                            title={RISK_HINT[query.risk] || undefined}
                          >
                            {query.statementType}
                          </span>
                        )}
                      </td>
                      <td className="muted">{query.savedBy || '—'}</td>
                      <td className="muted">{formatWhen(query.savedAt)}</td>
                      <td>
                        {/* Delete asks inline rather than in a dialog: it is one
                            row's worth of consequence, and the question fits in
                            the space the buttons already occupy. */}
                        {confirming === query.id ? (
                          <div className="row">
                            <span className="faint mono-sm">Delete for everyone?</span>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={busy}
                              onClick={() => remove(query.id)}
                            >
                              Yes, delete
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              onClick={() => setConfirming(null)}
                            >
                              Keep
                            </button>
                          </div>
                        ) : (
                          <div className="row">
                            <button
                              type="button"
                              className="btn btn-sm"
                              title="Puts the text in the Terminal editor without running it"
                              onClick={() => openInTerminal(query)}
                            >
                              Open in Terminal
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger-ghost btn-sm"
                              title="Remove this saved query"
                              onClick={() => setConfirming(query.id)}
                            >
                              Delete
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {open ? (
                      <tr>
                        <td colSpan={5}>
                          <pre className="logbox" style={{ maxHeight: 200 }}>
                            {query.sql}
                          </pre>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
