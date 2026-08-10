'use client';

import { useCallback, useEffect, useState } from 'react';
import DeployCard from '../components/DeployCard';

export default function DeployPage() {
  const [targets, setTargets] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/deploy/releases', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Failed to load targets (HTTP ${res.status})`);
        return;
      }
      setTargets(data.targets);
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
        <h1 className="page-title">Deploy</h1>
        <span className="page-sub">
          validate → confirm → atomic swap → restart → health check → auto-rollback
        </span>
      </div>

      {error ? (
        <div className="callout callout-danger" style={{ marginBottom: 13 }}>
          <span className="callout-icon">⛔</span>
          <div>{error}</div>
        </div>
      ) : null}

      {targets === null && !error ? (
        <div className="panel">
          <div className="empty">loading targets…</div>
        </div>
      ) : null}

      <div className="target-grid">
        {(targets || []).map((target) => (
          <DeployCard key={target.key} target={target} onChanged={load} />
        ))}
      </div>
    </>
  );
}
