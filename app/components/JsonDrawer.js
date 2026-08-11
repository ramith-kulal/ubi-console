'use client';

/**
 * JsonDrawer — pretty-printed view of a nested value from a result cell.
 *
 * Rows in this store are deeply nested (profile, docs.id.aadhaar.aadhaarOutput,
 * trackerObj, crifReport). A grid that stringifies those renders
 * "[object Object]", which is worse than useless: it looks like data.
 */

import { useEffect, useState } from 'react';

function prettyPrint(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // Circular or otherwise unserialisable — say so rather than crashing.
    return String(value);
  }
}

export default function JsonDrawer({ open, title, value, onClose }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    setCopied(false);
  }, [value]);

  if (!open) return null;

  const text = prettyPrint(value);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <span className="mono-sm">{title}</span>
          <span className="topbar-spacer" />
          <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
            {copied ? 'copied' : 'copy'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            close
          </button>
        </div>
        <pre className="drawer-body">{text}</pre>
      </aside>
    </>
  );
}
