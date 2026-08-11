import OpsConsole from './components/OpsConsole';

export const dynamic = 'force-dynamic';

/**
 * Operations — the tasks the team actually performs, as buttons rather than SQL.
 * Raw SQL lives on /terminal.
 */
export default function OperationsPage() {
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Operations</h1>
        <span className="page-sub">
          search → act → preview → confirm · every change is shown before it runs
        </span>
      </div>
      <OpsConsole />
    </>
  );
}
