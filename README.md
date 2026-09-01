# UBI Ops

Internal ops console for the Whatsloan/UBI **UAT** instance (`ip-172-31-21-69`).

Replaces two manual workflows:

- **Module B — Build Deployer** (built): drag-drop an Angular `dist.zip`, validate it,
  swap it in atomically, restart pm2, verify the new build is actually being served,
  auto-roll-back if it is not.
- **Module A — Query Console** (built): browse tables by state, run statements, and
  view / edit / delete rows. Writes are previewed and confirmed before they run.
- **Module C — Bypass flags** (built): edit `ubi-backend/src/config/bypass.json` as
  switches, then back up, write atomically, restart pm2 and verify — instead of
  `nano src/config/bypass.json` followed by `pm2 restart 0`.

Next.js 14 (App Router), plain JavaScript, no database of its own.

---

## Safety properties — do not remove these

| Property | Why it exists |
|---|---|
| Binds `127.0.0.1:4300` only | Every other service on this box binds `0.0.0.0`, so the EC2 security group is the only control. This app combines authenticated arbitrary DB access over Aadhaar/PAN/KCC/credit data with server-side command execution — a login page must not be the only thing between it and the internet. Access is via SSH tunnel. |
| Client sends only a **target key** | Never a path, never a command. Any path arriving from the browser would make this "write anywhere as `ubi-backend`, then run it". |
| `execFile(cmd[0], cmd.slice(1))` | No shell, no string interpolation, so no command-injection sink. |
| Zip-slip guard in [lib/zip-inspect.js](lib/zip-inspect.js) | Archive extraction is the classic path-traversal RCE. `../`, absolute paths, drive prefixes, NUL bytes and symlink entries are all rejected from the archive *listing*, before a byte is written. |
| Health check asserts the new `main.<hash>.js` | `PM2_SERVE_SPA: true` falls back to `index.html` for every path, so an HTTP 200 proves nothing — a stale build answers 200 just as happily. |
| Confirm tokens bind target + staged upload + sha256 | A token minted for one artifact cannot be replayed to deploy a different one, or the same one to a different target. |
| Bypass flags: only keys already in the file, with their existing types | The browser cannot invent a flag, delete one, or turn a boolean into a list. A typo'd flag name would be a flag the backend never reads — a bypass that silently does nothing is the worst outcome available here, so it is refused rather than written. |
| Bypass writes are atomic (temp file + `rename`) and preceded by a backup | `require('./bypass.json')` in a running backend can read a file mid-write. A rename means a reader sees the old file or the new one, never half of one. |
| Bypass changes are digest-bound both ways | The confirm token binds the file as reviewed **and** the file to be written, so a concurrent `nano` session over SSH is detected and refused rather than clobbered. |
| Every computed path re-checked with `assertInside()` | Defence in depth before any write or delete. |
| No production reference anywhere | Grepping the project for the prod proxy IP or prod store name returns nothing (see "Verification" below). The DB endpoint is hardcoded to loopback in [lib/db.js](lib/db.js), so prod is unreachable by construction rather than by policy. |

**Never run** `nvm alias default 20` or `pm2 update`. The pm2 daemon runs under Node 16
and all four existing apps inherit that interpreter; changing the default Node and then
updating/resurrecting the daemon would silently migrate `ubi-backend`, `mock-server`,
`frontend-etb-ntb` and `ubi-frontend` onto Node 20.

---

## Install on the instance

```bash
ssh ubi-backend@3.7.233.228
cd /home/ubi-backend/ops-dashboard

nvm install 20                    # do NOT set it as the default
node -v                           # confirm v20.x

npm ci
```

Create the two secrets (this file is gitignored and must never be committed):

```bash
cat > .env.local <<EOF
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
CONFIRM_HMAC_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
EOF
chmod 600 .env.local
```

Add yourself a login (password is prompted, never passed as an argument, never stored
in plaintext):

```bash
node scripts/add-user.js ramith
```

Build and start under pm2, **pinning only this app to Node 20**:

```bash
npm run build

pm2 start npm --name ubi-ops \
  --interpreter /home/ubi-backend/.nvm/versions/node/v20.<x>.<y>/bin/node \
  -- start
pm2 save
```

`npm start` binds `127.0.0.1:4300`. Reach it from your laptop with:

```bash
ssh -L 4300:localhost:4300 ubi-backend@3.7.233.228
# then open http://localhost:4300
```

---

## One-time migration per target

`ubi-dist` is currently a real directory. The deployer needs a symlink so releases can
be swapped atomically. Check status first:

```bash
node scripts/migrate-target.js                       # status of all targets, changes nothing
node scripts/migrate-target.js bankers-dashboard     # dry run, shows the exact steps
node scripts/migrate-target.js bankers-dashboard --confirm
```

It moves `ubi-dist` into `releases/legacy-<YYYYMMDD>/`, symlinks it back, restarts pm2,
then verifies the site serves. It is idempotent and refuses to touch a directory with no
`index.html`. **Do `bankers-dashboard` first**, confirm the site works, then
`etb-ntb-frontend`.

After migration it reports the legacy `ubi-dist.bak*`, `newfileunzipped` and ~30 loose
zips that could be cleaned up. It **never deletes them** — review by hand.

After a deploy, confirm SPA mode survived:

```bash
pm2 env 6 | grep PM2_SERVE_SPA      # must still be true
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:4200/some/deep/route   # 200, not 404
```

Restart (never delete-and-re-add) is what preserves `PM2_SERVE_SPA`.

---

## How a deploy works

1. Drop a `.zip` on a target card → `POST /api/deploy/upload`. Lands in
   `.staging/<uuid>/`. **Nothing live is touched.**
2. Validation: magic bytes, zip-slip, `index.html` present (root or one wrapper folder),
   size and zip-bomb caps. Plus a **diff against what is live** — added/removed/changed
   files and the old→new `main.<hash>.js`, with a prominent warning if the archive is
   identical to the current release, or is missing a large share of live files.
3. Confirm → `POST /api/deploy/commit`, which streams progress over SSE:
   - **extract** to `releases/<YYYYMMDD-HHMMSS>/`, stripping the wrapper folder;
     writes `meta.json` and retains the uploaded zip beside the release
   - **atomic swap**: `fs.symlink` to a temp name, then `fs.rename` over the live link
   - **restart**: `pm2 restart <name>` via `execFile`, stdout/stderr streamed
   - **health check**: fetch the health URL, assert the new bundle is referenced, retry
     with backoff
   - **prune** to `keepReleases` (5), logging exactly what was removed
4. Health-check failure → **automatic rollback** to the previous release, then restart
   and report, with the full log retained. The failed release is marked in its
   `meta.json` so the Releases list shows it as `FAILED`.
5. A lockfile per target prevents two people swapping concurrently.

Rollback from the Releases screen runs the same swap → restart → health-check path.

---

## Module C — Bypass flags

`/bypass` renders `src/config/bypass.json` as one row per key, in file order, and
replaces the SSH loop:

```
nano src/config/bypass.json   →   pm2 restart 0
```

Three things went wrong with that. `nano` writes an invalid JSON file just as happily
as a valid one, and the backend then fails to boot on a file nobody kept a copy of.
`pm2 restart 0` addresses a process by index, and indexes move. And there was no record
of who turned `V1_ENCRYPTION_BYPASS` on, or when.

**Two clicks total: flip a switch, then press the one button that appears.** There is no
separate review step and no confirm dialog — neither was earning its click. The pending
change is printed as chips in a bar pinned to the bottom of the viewport, directly beside
a red button that says what it will do (`Enable 1 bypass & restart`, or `Apply 3 changes
& restart`). Editing is local, so nothing is sent until that button is pressed.

The server still validates the change before writing, and the editable keys and their
types come from the file, not from the browser:

| Value in the file | Control | Accepted |
|---|---|---|
| `true` / `false` | switch | boolean only |
| `"uat"` | text | printable, single line, ≤ 200 chars |
| `3` | text | finite number |
| `["bre_status", ...]` | text, comma-separated | `[A-Za-z0-9_.-]{1,64}` per entry, no duplicates |
| `{ ... }`, `null`, mixed array | shown, not editable | — |

The button then plans and applies in one go — `POST /api/bypass` mints a confirm token
bound to the file's before/after digests, and `POST /api/bypass/apply` streams the write
over SSE:

- **backup** — the current file is copied to `.bypass-backups/bypass-<ts>-<user>.json`
  (beside the config file) *before* anything is written
- **write** — temp file in the same directory, `fsync`, `rename`; the original file mode
  is preserved and the file's own indentation is detected and reproduced
- **restart** — `pm2 restart <name>` (by name, never by index) via `execFile`, argv array,
  no shell
- **health** — `pm2 jlist` polled with backoff, and the process must be `online` in **two
  consecutive samples with the same restart count**. One `online` sample proves nothing:
  a crash-looping app is online for a fraction of a second at a time, which is exactly
  what a bypass.json the backend cannot boot with produces.
- **prune** to `keepBackups` (30)

Health failure → the backup is written back and pm2 restarted again, so a bad flag value
self-heals. If even that fails, the log says where the backup file is.

Every write is appended to `data/bypass-audit.jsonl` — `written` as soon as the bytes
land, then `verified` or `rolled-back` — and the last 25 entries are shown under the
panel. These flags disable OTP verification, payload encryption and credit-bureau calls;
"who turned this on, and is it still on" is a question that gets asked after the fact,
by which point the pm2 log has rotated.

The target is configured in [bypass-targets.json](bypass-targets.json) — path, pm2 name
and restart argv, none of which the browser can supply:

```json
{
  "ubi-backend": {
    "configPath": "/home/ubi-backend/server/ubi-backend/src/config/bypass.json",
    "restartCommand": ["pm2", "restart", "ubi-backend"],
    "healthUrl": null
  }
}
```

Set `healthUrl` to a backend URL to also require an HTTP response below 500 before a
change is accepted; with `null`, the health gate asserts the process is up but not that
it serves correct responses, and the UI says so.

---

## Tests

```bash
npm test        # 205 tests, no test framework dependency
```

Covers both security boundaries directly:

- **query-guard** — statement classification and channel routing, mandatory `WHERE`,
  comments-inside-strings vs real comments, multi-statement rejection, alias handling
  for both `UPDATE` and `DELETE` shapes, DDL object-name extraction.
- **zip-inspect** — hand-crafted zip-slip / absolute-path / symlink-entry archives,
  zip-bomb ratios, nested `dist/<project>/browser/` layouts, custom entry documents.
- **confirm-token** — binding and expiry, including cross-payload replay.
- **deploy** — a full integration suite against a real filesystem and HTTP server.
- **bypass** — a full integration suite against a real filesystem and a real child
  process. The fake `pm2` reads the config file it was pointed at and reports `errored`
  when it contains `BROKEN: true`, so the health gate and the auto-restore are actually
  exercised; a double that always reported `online` would pass with both deleted.

To verify no production reference exists (spec §8):

```bash
grep -ri "<prod-proxy-ip>\|<prod-store-name>" . --exclude-dir=node_modules --exclude-dir=.next
```

The integration suite models the one pm2 behaviour that makes this subtle: `pm2 serve`
resolves the served directory once and holds it, so swapping the symlink changes nothing
until restart. A test server that re-read the symlink per request would pass even if the
restart were removed entirely.

---

## Layout

```
lib/query-guard.js    statement analysis + channel routing  ← security boundary (Module A)
lib/zip-inspect.js    archive validation + diff vs live     ← security boundary (Module B)
lib/db.js             NoSQL client (endpoint HARDCODED), PK lookup, key-based row ops
lib/deploy.js         extract, swap, restart, verify, rollback, prune, lock
lib/bypass.js         bypass.json read/validate/atomic-write, restart, verify, restore (Module C)
lib/targets.js        server-side target allowlist + assertInside()
lib/confirm-token.js  stateless HMAC confirm tokens
lib/staging.js        upload scratch space
lib/auth.js           jose JWT (Edge-verifiable in middleware.js)
scripts/migrate-target.js   one-time directory → symlink conversion
scripts/add-user.js         bcrypt user management
scripts/gen-tables.js       generates data/tables.json from ubi-backend
```

State lives on disk by design: `users.json`, `saved-queries.json`, per-release
`meta.json`. No app database.

---

## Module A — Query Console

### Statement policy

**All statement types are permitted, including DDL.** This overrides the original
spec's SELECT/UPDATE/DELETE whitelist — a deliberate decision by the tool's owner.
What the guard still does is make the blast radius visible before anything runs:

| Statement | Treatment |
|---|---|
| `SELECT` | Runs immediately. `LIMIT 500` appended if you didn't set one. |
| `INSERT` / `UPSERT` | Confirm step. No preview is possible — the rows don't exist yet. |
| `UPDATE` / `DELETE` | **`WHERE` is mandatory.** The exact affected rows are previewed, then confirmed. |
| `DROP` / `TRUNCATE` / `CREATE` / `ALTER` / `GRANT` | Confirm step requiring the **object name to be typed**. No preview can exist and nothing is reversible. |

The `WHERE` requirement on `UPDATE`/`DELETE` is kept because a row-level preview is
genuinely achievable there, so running blind buys nothing. DDL has no such option,
hence the typed confirmation instead.

Still refused outright, for all statement types:

- **More than one statement per run** — two statements would share one confirmation.
- **SQL comments** (`--`, `/* */`) — an apostrophe inside `/* it's fine */`
  desynchronises quote tracking, so the preview could describe different rows than the
  statement touches. That silent divergence is the worst failure this module can have.
- Unterminated strings, unbalanced parens, ambiguous `WHERE`.

### Execution channels

Oracle NoSQL does not accept DDL through `query()`. [lib/query-guard.js](lib/query-guard.js)
classifies each statement and [lib/db.js](lib/db.js) dispatches it:

- `query()` — SELECT, INSERT, UPSERT, UPDATE, DELETE
- `tableDDL()` — CREATE/DROP/ALTER TABLE, CREATE/DROP INDEX, TRUNCATE
- `adminDDL()` — GRANT, REVOKE, namespace/user/role statements

Getting this wrong means DDL simply fails, so the routing is functional, not cosmetic.

### Confirm tokens

A write needs an HMAC token bound to the **exact statement text**, minted by
`/api/query/preview`. A token from `DELETE … WHERE id='1'` will not authorise
`… id='2'`, nor a different table, nor a different case. 120s TTL.

### Operations screen

`/` is the everyday-task screen: pick a state and a table, search, act on a row. It
builds no SQL in the browser — [lib/ops-actions.js](lib/ops-actions.js) does that, so a
custId typed into the search box cannot break out of its literal and widen a `WHERE`.

Two interaction rules it follows:

- **The value is the control.** `appStatus` is a dropdown on the row itself, showing what
  the row currently holds. Picking a new status goes straight to the confirm dialog — it
  used to be a button that opened a dialog that contained the dropdown, which was three
  clicks to change one field. If a row holds a status that is not in
  `data/app-statuses.json`, that value is added to its own dropdown rather than the
  select silently displaying a different one.
- **One header, not a label per value.** Results are fixed columns with the field names
  in a single sticky header. Repeating `custId … applicant_name …` on every row meant
  nothing lined up, so scanning a result set was reading rather than glancing.

The remaining actions (clear a field, reset a land record, delete) are one `actions…`
menu per row instead of four buttons; the field-clear allowlist from `NULLABLE_PATHS` is
an option group inside it. Every entry still goes plan → `/api/query/preview` → confirm →
`/api/query/execute`, so the affected-row count, the exact statement, and any typed
confirmation are unchanged.

### Row editing

Clicking ✎ on a result row opens an editor that uses the driver's `get`/`put`/`delete`
by **full primary key** rather than SQL text — mirroring `deleteQuery` /
`deleteQueryV2..V4` in ubi-backend's `sqlqueries.js`. For the most common operation in
this console (fixing or removing one applicant / custid record) there is then no clause
to mistype and no chance of matching more rows than intended.

The primary key is read from the database via `getTable()`, never hardcoded — a wrong
key would mean an "edit" silently writing a new row and leaving the original behind.
Primary key columns are not editable for the same reason, and a partial key is rejected.

Note `put()` replaces the **whole row**, so the editor merges scalar edits over the
loaded row rather than sending a patch. Nested fields (`profile`, `docs`, `trackerObj`,
`crifReport`) are edited via the JSON tab.

### Table browser

`data/tables.json` is generated from `ubi-backend/src/database/tables.json` by
`npm run gen-tables` — **26 groups, 1278 table refs**, not the 8 named in the build
spec. The extra ones (`MAHARASHTRA`, `OD`, `TN`, `RJ`, `GJ`, `CH`, `TR`, `AS`, plus
non-state blocks like `SATSURE`, `PROFILE`, `CIBIL`) are real. Grouping is faithful
rather than flattened.

The generator also reports the **51 state keys shadowed by `GENERAL`**: ubi-backend's
`generalutils/utils.js` spreads the `GENERAL` block last, so a key present in both
silently resolves to the GENERAL table there. Those are tagged `shadowed` in the rail,
because the one place that ambiguity must not exist is the screen where someone is
deciding which physical table to edit.

Regenerate after a `tables.json` change:

```bash
npm run gen-tables    # needs the ubi-backend checkout; pass --source if it moved
```

### Saved queries

Clicking a saved query **loads it into the editor and nothing more**. There is
deliberately no one-click path from the list to a destructive statement.
