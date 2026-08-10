import './globals.css';
import { getSession } from '@/lib/session-server';
import Shell from './components/Shell';

export const metadata = {
  title: 'UBI Ops',
  description: 'Internal ops console — UAT',
};

// The environment banner must never be a stale cached render.
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }) {
  const session = await getSession();

  return (
    <html lang="en">
      <body>
        <div id="app-root">
          {session ? <Shell username={session.username}>{children}</Shell> : children}
        </div>
      </body>
    </html>
  );
}
