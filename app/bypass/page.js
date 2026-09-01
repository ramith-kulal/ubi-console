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
  const [showAudit, setShowAudit] = useState(false);

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
          flip a switch, then apply · backup → write → restart → verify → auto-restore
        </span>
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
              <span>History</span>
              <span className="faint" style={{ fontWeight: 400 }}>
                {data.audit.length ? `${data.audit.length} recorded` : 'nothing recorded yet'}
              </span>
              <span className="topbar-spacer" />
              <button
                type="button"
                className="head-link"
                onClick={() => setShowAudit((v) => !v)}
                disabled={data.audit.length === 0}
              >
                {showAudit ? 'hide' : 'show'}
              </button>
            </div>
            {showAudit && data.audit.length ? (
              <div className="panel-body" style={{ padding: 0 }}>
                {data.audit.map((entry, i) => (
                  <div className="list-row" key={`${entry.at}-${i}`}>
                    <div className="list-row-data">
                      <span className="list-kv">{formatWhen(entry.at)}</span>
                      <span className="list-kv">
                        <span className="faint">by</span> {entry.user || '—'}
                      </span>
                      <span className={`tag ${PHASE_TAG[entry.phase] || 'tag-danger'}`}>
                        {entry.phase}
                      </span>
                      <span className="list-kv">
                        {(entry.changes || [])
                          .map((c) => `${c.key} ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`)
                          .join('  ·  ') ||
                          (entry.restoredFrom ? `restored ${entry.restoredFrom}` : '')}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
