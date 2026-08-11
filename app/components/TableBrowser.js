'use client';

/**
 * TableBrowser — the left rail: pick a state group, then a table.
 *
 * Grouping is faithful to ubi-backend's DATA_TABLES rather than flattened. That
 * matters: `generalutils/utils.js` spreads the GENERAL block last, so a key
 * present in both GENERAL and a state group silently resolves to the GENERAL
 * table. Flattening here would reproduce that ambiguity in the one place someone
 * is trying to work out which physical table they are about to edit.
 */

import { useMemo, useState } from 'react';

export default function TableBrowser({ tree, onInsertTable, onBrowseTable, selectedTable }) {
  const [group, setGroup] = useState('KARNATAKA');
  const [filter, setFilter] = useState('');
  const [showBackups, setShowBackups] = useState(false);

  const groups = tree?.groups || [];

  const current = useMemo(
    () => groups.find((g) => g.group === group) || groups[0] || null,
    [groups, group]
  );

  const tables = useMemo(() => {
    if (!current) return [];
    const needle = filter.trim().toUpperCase();
    return current.tables.filter((t) => {
      if (!showBackups && t.kind === 'backup') return false;
      if (!needle) return true;
      return t.name.toUpperCase().includes(needle) || (t.key || '').toUpperCase().includes(needle);
    });
  }, [current, filter, showBackups]);

  const shadowedKeys = useMemo(() => {
    const set = new Set();
    for (const s of tree?.shadowedByGeneral || []) {
      if (s.group === group) set.add(s.key);
    }
    return set;
  }, [tree, group]);

  const stateGroups = groups.filter((g) => g.kind === 'state');
  const generalGroups = groups.filter((g) => g.kind === 'general');
  const otherGroups = groups.filter((g) => g.kind === 'other');

  return (
    <div className="rail">
      <div className="rail-section">
        <label className="rail-label" htmlFor="state-select">
          state / group
        </label>
        <select
          id="state-select"
          value={current?.group || ''}
          onChange={(e) => setGroup(e.target.value)}
        >
          {stateGroups.length ? (
            <optgroup label="States">
              {stateGroups.map((g) => (
                <option key={g.group} value={g.group}>
                  {g.group}
                  {g.stateCode ? ` (${g.stateCode})` : ''}
                </option>
              ))}
            </optgroup>
          ) : null}
          {generalGroups.length ? (
            <optgroup label="Shared">
              {generalGroups.map((g) => (
                <option key={g.group} value={g.group}>
                  {g.group}
                </option>
              ))}
            </optgroup>
          ) : null}
          {otherGroups.length ? (
            <optgroup label="Other blocks">
              {otherGroups.map((g) => (
                <option key={g.group} value={g.group}>
                  {g.group}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </div>

      <div className="rail-section">
        <input
          type="text"
          placeholder="filter tables…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <div className="rail-section rail-row">
        <label className="rail-checkbox">
          <input
            type="checkbox"
            checked={showBackups}
            onChange={(e) => setShowBackups(e.target.checked)}
          />
          show _BK_ backups
        </label>
      </div>

      <div className="rail-count faint mono-sm">
        {tables.length} table{tables.length === 1 ? '' : 's'}
        {tree?.dbReachable === false ? ' · db unreachable' : ''}
      </div>

      <div className="rail-list">
        {tables.map((table) => {
          const isSelected = selectedTable === table.name;
          return (
            <div
              key={`${table.name}:${table.kind}:${table.key}`}
              className={`rail-item${isSelected ? ' selected' : ''}`}
            >
              <button
                type="button"
                className="rail-item-name"
                title={`Insert "${table.name}" at the cursor`}
                onClick={() => onInsertTable(table.name)}
              >
                {table.name}
              </button>

              <div className="rail-item-meta">
                {table.nested ? (
                  <span className="tag" title={`Child table of ${table.parent} — needs NESTED TABLES, not a JOIN`}>
                    nested
                  </span>
                ) : null}
                {table.kind === 'backup' ? <span className="tag tag-warn">backup</span> : null}
                {shadowedKeys.has(table.key) ? (
                  <span
                    className="tag tag-warn"
                    title={`ubi-backend's merge spreads GENERAL last, so the key "${table.key}" resolves to the GENERAL table there`}
                  >
                    shadowed
                  </span>
                ) : null}
                {table.exists === false ? (
                  <span className="tag tag-danger" title="Not present in this store">
                    missing
                  </span>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title="Browse rows in this table"
                  onClick={() => onBrowseTable(table.name)}
                >
                  browse
                </button>
              </div>
            </div>
          );
        })}
        {tables.length === 0 ? <div className="empty">no tables match</div> : null}
      </div>
    </div>
  );
}
