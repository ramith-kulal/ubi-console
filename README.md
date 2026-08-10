# UBI Ops

Internal ops console for the Whatsloan/UBI **UAT** instance (`ip-172-31-21-69`).

Replaces two manual workflows:

- **Module B — Build Deployer** (built): drag-drop an Angular `dist.zip`, validate it,
  swap it in atomically, restart pm2, verify the new build is actually being served,
  auto-roll-back if it is not.
- **Module A — Query Console** (not built yet): Oracle NoSQL query console with a
  two-step confirm for `UPDATE`/`DELETE`. See "What is not built yet" below.

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
| Every computed path re-checked with `assertInside()` | Defence in depth before any write or delete. |
| No production reference anywhere | `grep -ri "172.27.130.67\|ubistore" .` returns nothing. Loopback binding makes prod unreachable by construction. |

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

## Tests

```bash
npm test        # 53 tests, no test framework dependency
```

Covers the security boundary directly: hand-crafted zip-slip / absolute-path /
symlink-entry archives, zip-bomb ratios, wrapper detection, confirm-token binding and
expiry, and a full deploy integration suite against a real filesystem and HTTP server.

The integration suite models the one pm2 behaviour that makes this subtle: `pm2 serve`
resolves the served directory once and holds it, so swapping the symlink changes nothing
until restart. A test server that re-read the symlink per request would pass even if the
restart were removed entirely.

---

## Layout

```
lib/zip-inspect.js    archive validation + diff vs live   ← most security-critical
lib/deploy.js         extract, swap, restart, verify, rollback, prune, lock
lib/targets.js        server-side target allowlist + assertInside()
lib/confirm-token.js  stateless HMAC confirm tokens
lib/staging.js        upload scratch space
lib/auth.js           jose JWT (Edge-verifiable in middleware.js)
scripts/migrate-target.js   one-time directory → symlink conversion
scripts/add-user.js         bcrypt user management
scripts/gen-tables.js       generates data/tables.json from ubi-backend (Module A)
```

State lives on disk by design: `users.json`, per-release `meta.json`. No app database.

---

## What is not built yet

**Module A — Query Console.** Deferred; Module B was built first. Already in place:

- `data/tables.json` — generated from `ubi-backend/src/database/tables.json`
  (26 groups, 1278 table refs) via `npm run gen-tables`. It also reports the 51 state
  keys that ubi-backend's `generalutils/utils.js` silently shadows by spreading
  `GENERAL` last.
- `lib/confirm-token.js` — the two-step confirm mechanism the query console needs.
- Sidebar nav shows Query and Saved as `SOON`; `/` redirects to `/deploy`.

Still to write: `lib/db.js`, `lib/query-guard.js` (+ its unit tests, first), the query
API routes, and the console UI.

`data/tables.json` has **26 groups**, not the 8 named in the build spec — the extra ones
(`MAHARASHTRA`, `OD`, `TN`, `RJ`, `GJ`, `CH`, `TR`, `AS`, plus non-state groups like
`SATSURE`, `PROFILE`, `CIBIL`) are real blocks in `tables.json`. The generator groups
faithfully rather than flattening, so the state filter should be built from the generated
file, not hardcoded.
