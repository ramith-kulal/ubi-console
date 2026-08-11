'use client';

/**
 * Saved queries.
 *
 * Clicking one LOADS it into the editor. It never executes. There is deliberately
 * no one-click path from this list to a destructive statement — whoever runs it
 * still goes through preview and confirmation on the Query screen.
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

export default function SavedPage() {
  const router = useRouter();
  const [queries, setQueries] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/saved', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Failed to load (HTTP ${res.status})`);
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
    try {
      const res = await fetch(`/api/saved?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Could not delete');
        return;
      }
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  /** Hand the text to the Query screen; it does not run. */
  function loadIntoEditor(query) {
    try {
      sessionStorage.setItem('ubi-ops:pending-sql', query.sql);
    } catch {
      /* sessionStorage unavailable — the user can still copy the text */
    }
    router.push('/');
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Saved</h1>
        <span className="page-sub">opening a query loads it into the editor — it never runs</span>
      </div>

      {error ? (
        <div className="callout callout-danger" style={{ marginBottom: 12 }}>
          <span className="callout-icon">⛔</span>
          <div>{error}</div>
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-head">
          <span>Saved queries</span>
          <span className="topbar-spacer" />
          <span className="mono-sm muted">{queries ? queries.length : '—'}</span>
        </div>

        {queries === null ? (
          <div className="empty">loading…</div>
        ) : queries.length === 0 ? (
          <div className="empty">
            Nothing saved yet. Use “Save…” on the Query screen.
          </div>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>name</th>
                <th style={{ width: 110 }}>type</th>
                <th style={{ width: 130 }}>saved by</th>
                <th style={{ width: 150 }}>saved</th>
                <th style={{ width: 190 }} />
              </tr>
            </thead>
            <tbody>
              {queries.map((query) => (
                <Fragment key={query.id}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className="cell-json"
                        onClick={() => setExpanded(expanded === query.id ? null : query.id)}
                      >
                        {query.name}
                      </button>
                    </td>
                    <td>
                      {query.blocked ? (
                        <span className="tag tag-danger">blocked</span>
                      ) : (
                        <span
                          className={`tag ${
                            query.risk === 'destructive'
                              ? 'tag-danger'
                              : query.risk === 'write'
                                ? 'tag-warn'
                                : 'tag-ok'
                          }`}
                        >
                          {query.statementType}
                        </span>
                      )}
                    </td>
                    <td className="muted">{query.savedBy || '—'}</td>
                    <td className="muted">{formatWhen(query.savedAt)}</td>
                    <td>
                      <div className="row">
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => loadIntoEditor(query)}
                        >
                          Load into editor
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => remove(query.id)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expanded === query.id ? (
                    <tr>
                      <td colSpan={5}>
                        <pre className="logbox" style={{ maxHeight: 200 }}>
                          {query.sql}
                        </pre>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
