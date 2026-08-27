'use client';

/**
 * Bypass flags — the ubi-backend feature switches, without SSH.
 *
 * Replaces: `nano src/config/bypass.json` + `pm2 restart 0`.
 */

import { useCallback, useEffect, useState } from 'react';
import BypassPanel from '../components/BypassPanel';

const PHASE_TAG = {
  written: 'tag-accent',
  verified: 'tag-ok',
  'rolled-back': 'tag-warn',
};

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(
    d.getSeconds()
  )}`;
}

export default function BypassPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/bypass', { cache: 'no-store' });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload.error || `Failed to load bypass config (HTTP ${res.status})`);
        return;
      }
      setData(payload);
      setError(null);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Bypass flags</h1>
        <span className="page-sub">
          edit → review → backup → atomic write → pm2 restart → verify → auto-restore
        </span>
      </div>

      <div className="callout callout-warn" style={{ marginBottom: 13 }}>
        <span className="callout-icon">⚠</span>
        <div>
          These flags switch off real checks — OTP verification, payload encryption, credit
          bureau calls, name matching. Applying a change restarts the backend, so every
          in-flight request is dropped. Every write is backed up and recorded below.
        </div>
      </div>

      {error ? (
        <div className="callout callout-danger" style={{ marginBottom: 13 }}>
          <span className="callout-icon">⛔</span>
          <div>{error}</div>
        </div>
      ) : null}

      {data === null && !error ? (
        <div className="panel">
          <div className="empty">loading bypass config…</div>
        </div>
      ) : null}

      <div className="stack">
        {(data?.targets || []).map((target) => (
          <BypassPanel key={target.key} target={target} onChanged={load} />
        ))}

        {data?.targets?.length ? (
          <div className="panel">
            <div className="panel-head">
              <span>Recent changes</span>
              <span className="topbar-spacer" />
              <span className="tag">{data.audit.length}</span>
            </div>
            <div className="panel-body">
              {data.audit.length === 0 ? (
                <div className="empty">no changes recorded yet</div>
              ) : (
                data.audit.map((entry, i) => (
                  <div className="ops-item" key={`${entry.at}-${i}`}>
                    <div className="ops-item-data">
                      <span className="ops-kv">{formatWhen(entry.at)}</span>
                      <span className="ops-kv">
                        <span className="faint">by</span> {entry.user || '—'}
                      </span>
                      <span className={`tag ${PHASE_TAG[entry.phase] || 'tag-danger'}`}>
                        {entry.phase}
                      </span>
                      <span className="ops-kv faint">{entry.action}</span>
                      <span className="ops-kv">
                        {(entry.changes || [])
                          .map(
                            (c) => `${c.key}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`
                          )
                          .join('  ·  ') || entry.restoredFrom || ''}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
