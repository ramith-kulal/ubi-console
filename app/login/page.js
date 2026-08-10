'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    // Read straight from the form rather than from React state. A password
    // manager can fill an input without firing onChange, which leaves the
    // controlled state stale while the field visibly shows a value — the form
    // then posts the wrong credentials and the failure looks like a bad
    // password. Whatever is actually in the fields is what gets sent.
    const formData = new FormData(event.currentTarget);
    const submittedUsername = String(formData.get('username') || '').trim();
    const submittedPassword = String(formData.get('password') || '');

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username: submittedUsername,
          password: submittedPassword,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setError(data.error || `Login failed (HTTP ${res.status})`);
        setBusy(false);
        return;
      }

      const next = searchParams.get('next');
      router.push(next && next.startsWith('/') ? next : '/deploy');
      router.refresh();
    } catch (err) {
      setError(`Login request failed: ${err.message}`);
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">UBI Ops</div>
        <div className="row" style={{ marginBottom: 18 }}>
          <span className="env-badge">
            <span className="env-dot" />
            UAT · ip-172-31-21-69
          </span>
        </div>

        <div className="login-field">
          <label htmlFor="username">username</label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>

        <div className="login-field">
          <label htmlFor="password">password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        {/* Disabled only while submitting. Gating this on React state would
            leave the button dead when a password manager fills the fields
            without firing onChange; `required` covers empty submits. */}
        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: '100%', marginTop: 4 }}
          disabled={busy}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {error ? <div className="login-error">{error}</div> : null}

        <div className="faint mono-sm" style={{ marginTop: 16, lineHeight: 1.5 }}>
          Accounts are managed on the instance:
          <br />
          node scripts/add-user.js &lt;username&gt;
        </div>
      </form>
    </div>
  );
}
