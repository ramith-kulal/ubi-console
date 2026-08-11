'use client';

/**
 * ResultsGrid — the results table.
 *
 * Cell rendering is the substance here, not decoration. Rows from this store
 * carry deep JSON, so every cell is classified before it is rendered and objects
 * or arrays become an openable `{…} ⤢` chip instead of "[object Object]".
 */

import { useMemo, useState } from 'react';
import JsonDrawer from './JsonDrawer';

const MAX_INLINE_STRING = 120;

function classify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

/** Union of keys across all rows — different rows can carry different fields. */
function deriveColumns(rows) {
  const seen = [];
  const index = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (!index.has(key)) {
        index.add(key);
        seen.push(key);
      }
    }
  }
  return seen;
}

function Cell({ value, onOpen, label }) {
  const kind = classify(value);

  if (kind === 'null') return <span className="cell-null">null</span>;

  if (kind === 'object' || kind === 'array') {
    const size = kind === 'array' ? value.length : Object.keys(value).length;
    return (
      <button type="button" className="cell-json" onClick={() => onOpen(value, label)}>
        {kind === 'array' ? `[${size}]` : '{…}'} ⤢
      </button>
    );
  }

  if (kind === 'boolean') {
    return <span className="cell-bool">{value ? 'true' : 'false'}</span>;
  }

  if (kind === 'number') return <span className="cell-num">{String(value)}</span>;

  if (kind === 'date') return <span>{value.toISOString()}</span>;

  const text = String(value);
  if (text.length > MAX_INLINE_STRING) {
    return (
      <span title={text}>
        {text.slice(0, MAX_INLINE_STRING)}
        <button
          type="button"
          className="cell-json"
          style={{ marginLeft: 6 }}
          onClick={() => onOpen(value, label)}
        >
          ⤢
        </button>
      </span>
    );
  }
  return <span>{text}</span>;
}

export default function ResultsGrid({
  rows,
  elapsedMs,
  truncated,
  limitApplied,
  effectiveLimit,
  onSelectRow,
  selectable = false,
  emptyMessage = 'no rows',
}) {
  const [tab, setTab] = useState('results');
  const [drawer, setDrawer] = useState({ open: false, value: null, title: '' });

  const columns = useMemo(() => deriveColumns(rows || []), [rows]);

  const openDrawer = (value, title) => setDrawer({ open: true, value, title });
  const closeDrawer = () => setDrawer({ open: false, value: null, title: '' });

  const count = rows ? rows.length : 0;

  return (
    <div className="panel results-panel">
      <div className="panel-head">
        <div className="tabs">
          <button
            type="button"
            className={`tab${tab === 'results' ? ' active' : ''}`}
            onClick={() => setTab('results')}
          >
            Results
          </button>
          <button
            type="button"
            className={`tab${tab === 'json' ? ' active' : ''}`}
            onClick={() => setTab('json')}
          >
            Raw JSON
          </button>
        </div>

        <span className="topbar-spacer" />

        <span className="mono-sm muted">
          {count} row{count === 1 ? '' : 's'}
          {typeof elapsedMs === 'number' ? ` · ${elapsedMs} ms` : ''}
        </span>
        {limitApplied ? (
          <span className="tag tag-accent" title="No LIMIT in your query, so one was applied">
            LIMIT {effectiveLimit}
          </span>
        ) : null}
        {truncated ? (
          <span className="tag tag-warn" title="The row cap was reached; more rows exist">
            truncated
          </span>
        ) : null}
      </div>

      {tab === 'results' ? (
        count === 0 ? (
          <div className="empty">{emptyMessage}</div>
        ) : (
          <div className="grid-scroll">
            <table className="grid">
              <thead>
                <tr>
                  {selectable ? <th style={{ width: 34 }} /> : null}
                  <th style={{ width: 44 }}>#</th>
                  {columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {selectable ? (
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          title="Open this row for edit or delete"
                          onClick={() => onSelectRow(row)}
                        >
                          ✎
                        </button>
                      </td>
                    ) : null}
                    <td className="faint">{rowIndex + 1}</td>
                    {columns.map((column) => (
                      <td key={column}>
                        <Cell
                          value={row ? row[column] : null}
                          label={`row ${rowIndex + 1} · ${column}`}
                          onOpen={openDrawer}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <pre className="logbox" style={{ maxHeight: 420 }}>
          {JSON.stringify(rows, null, 2)}
        </pre>
      )}

      <JsonDrawer
        open={drawer.open}
        title={drawer.title}
        value={drawer.value}
        onClose={closeDrawer}
      />
    </div>
  );
}
