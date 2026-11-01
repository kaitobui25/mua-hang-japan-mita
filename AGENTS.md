# Mita Japan — Agent Rules

- **Inspect first:** check `git status`, affected code, current processes and actual DB target. Local API is `127.0.0.1:4000`, Mita PostgreSQL is `127.0.0.1:5433`; port `15432` is a temporary VPS tunnel, not the local DB.
- **Prevent schema drift:** before shipping a DB-dependent change, compare every required table/column/index with both migration SQL **and the target database's actual schema** using read-only queries (`information_schema`, `to_regclass`). SQL files do not prove migrations ran.
- **Health is insufficient:** `/api/health` checks DB connectivity (`SELECT 1`), not whether login, orders or workers have the columns they need. Check affected feature schemas separately.
- **Change as one unit:** update queries, additive/idempotent migration, migration wiring and regression tests together. Test upgrades from an older schema and repeat application in a disposable DB.
- **Auth example:** Owner/Staff login requires `admin_accounts.username`, `role`, `enabled` and `admin_staff_login_limit`. Missing schema causes an internal error, **not** a wrong password. Never hide SQL failures as HTTP 401 or keep retrying real Owner login.
- **No surprise migrations:** never run `npm run db:migrate`, `scripts/start-local.ps1`, init/reset/truncate DB or change Owner credentials as a side effect of starting/fixing the API. `db:migrate` applies multiple SQL files beyond Admin.
- **Active data needs approval:** for any local-active or VPS schema/data change, identify the exact target and impact, review the SQL and rollback path, verify a restorable backup, and obtain explicit authorization before applying it. Never silently migrate or sync VPS.
- **Test safely:** use isolated test DBs and synthetic credentials for login/session/roles/rate-limit cases; verify successful and failed auth, not just health. Do not use a real Owner password in automated tests.
- **Protect running work:** do not stop/restart workers, Supervisor, gateway, PostgreSQL, VPS processes or foreign port owners without specific authorization and verified ownership. Do not use generic kill-by-port.
- **Verify and report:** run relevant typecheck/tests plus PowerShell 5.1/WinForms checks when affected. State what was verified on a real environment and what remains unverified; never claim a passing unit test proves the deployed schema matches.
- **Preserve privacy and scope:** do not print secrets, password hashes, tokens, cookies or customer data; leave unrelated files/changes intact and commit only reviewed task files.
