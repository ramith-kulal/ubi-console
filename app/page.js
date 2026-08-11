import QueryConsole from './components/QueryConsole';

export const dynamic = 'force-dynamic';

export default function QueryPage() {
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Query</h1>
        <span className="page-sub">
          Oracle NoSQL · KVStore · writes are previewed and confirmed before they run
        </span>
      </div>
      <QueryConsole />
    </>
  );
}
