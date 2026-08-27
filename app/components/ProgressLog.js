'use client';

/**
 * ProgressLog — the step list and streamed output for a deploy or rollback.
 *
 * Design principle 4: long operations stream their output. An operator watching
 * "restart ✓ / health ⟳" learns where a deploy is; a spinner teaches nothing and
 * a spinner that ends in "failed" teaches nothing twice.
 */

import { useEffect, useRef } from 'react';

const DEPLOY_STEPS = [
  { name: 'extract', label: 'Extract to release dir' },
  { name: 'swap', label: 'Atomic symlink swap' },
  { name: 'restart', label: 'pm2 restart' },
  { name: 'health', label: 'Health check (asserts new bundle)' },
  { name: 'prune', label: 'Prune old releases' },
];

const ROLLBACK_STEPS = [
  { name: 'swap', label: 'Atomic symlink swap' },
  { name: 'restart', label: 'pm2 restart' },
  { name: 'health', label: 'Health check (asserts bundle)' },
];

const BYPASS_STEPS = [
  { name: 'backup', label: 'Back up the current bypass.json' },
  { name: 'write', label: 'Atomic write (temp file + rename)' },
  { name: 'restart', label: 'pm2 restart' },
  { name: 'health', label: 'Verify the process stays online' },
  { name: 'prune', label: 'Prune old backups' },
];

const ICONS = { pending: '·', running: '⟳', ok: '✓', failed: '✗' };

const MODES = { deploy: DEPLOY_STEPS, rollback: ROLLBACK_STEPS, bypass: BYPASS_STEPS };

export default function ProgressLog({ steps, logs, mode = 'deploy' }) {
  const logRef = useRef(null);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const definition = MODES[mode] || DEPLOY_STEPS;
  const rolledBack = Boolean(steps.rollback);

  const shown = [...definition];
  if (rolledBack) {
    shown.push({
      name: 'rollback',
      label:
        mode === 'bypass'
          ? 'Automatic rollback to the previous bypass.json'
          : 'Automatic rollback to previous release',
    });
  }

  return (
    <div className="stack">
      <div className="steps">
        {shown.map((step) => {
          const status = steps[step.name] || 'pending';
          return (
            <div key={step.name} className={`step ${status}`}>
              <span className="step-icon">
                {status === 'running' ? <span className="spin">⟳</span> : ICONS[status]}
              </span>
              <span className="step-name">{step.label}</span>
            </div>
          );
        })}
      </div>

      <div className="logbox" ref={logRef}>
        {logs.length === 0 ? <span className="faint">waiting for output…</span> : null}
        {logs.map((line, i) => (
          <div key={i} className={`log-line ${line.kind ? `log-${line.kind}` : ''}`}>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
