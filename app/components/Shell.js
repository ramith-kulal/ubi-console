'use client';

/**
 * Shell — topbar + sidebar wrapper present on every authenticated screen.
 *
 * The environment badge is deliberately not conditional and not collapsible.
 * "Which box am I on" is the question that precedes the worst mistakes, and a
 * permanently visible answer is the cheapest possible defence.
 */

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const NAV = [
  { href: '/', label: 'Query', icon: '▸', soon: true },
  { href: '/deploy', label: 'Deploy', icon: '▸' },
  { href: '/releases', label: 'Releases', icon: '▸' },
  { href: '/saved', label: 'Saved', icon: '▸', soon: true },
];

export default function Shell({ username, children }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">UBI Ops</span>

        <span className="env-badge" title="Non-production. UAT instance ip-172-31-21-69.">
          <span className="env-dot" />
          UAT · ip-172-31-21-69
        </span>

        <span className="topbar-spacer" />

        <span className="topbar-user">{username}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
          Logout
        </button>
      </header>

      <div className="shell-body">
        <nav className="sidebar">
          {NAV.map((item) => {
            const active =
              item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);

            if (item.soon) {
              return (
                <span
                  key={item.href}
                  className="nav-item disabled"
                  title="Query Console — not built yet"
                >
                  <span>{item.icon}</span>
                  {item.label}
                  <span className="nav-label-soon">SOON</span>
                </span>
              );
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`nav-item${active ? ' active' : ''}`}
              >
                <span>{item.icon}</span>
                {item.label}
              </Link>
            );
          })}

          <div className="nav-section">Instance</div>
          <div className="nav-item disabled" style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
            127.0.0.1:4300
          </div>
        </nav>

        <main className="main">{children}</main>
      </div>
    </div>
  );
}
