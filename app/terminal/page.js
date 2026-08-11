import QueryConsole from '../components/QueryConsole';

export const dynamic = 'force-dynamic';

/**
 * The raw SQL terminal. Separate from Operations on purpose: the everyday tasks
 * live on their own screen with fixed, reviewed statements, and this is the
 * escape hatch for everything else.
 */
export default function TerminalPage() {
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Terminal</h1>
        <span className="page-sub">
          raw SQL · Oracle NoSQL KVStore · writes are previewed and confirmed
        </span>
      </div>
      <QueryConsole />
    </>
  );
}
