# Mita Hermes VPS — read-only QA gate

This checklist accompanies Option B in .agents/plan/06_mita_hermes_vps_postgresql_grill_plan.md. No DNS, VPS configuration, database contents, or other services are changed by the QA script. Never approve cutover based only on HTTP checks; 1 GiB RAM, swap, PostgreSQL connections and E-KAIWA still require a concurrent operator review.

## 1. Run local deterministic tests

On Windows in the Mita repository:

~~~powershell
node --test ./scripts/test-vps-selftest.mjs
node ./scripts/test-vps-smoke.mjs --help
~~~

The self-test uses a mock gateway and a loopback-only HTTP transport check; it makes no external network requests. It validates explicit target selection, rejection of unverified rows, default strict rights mode and explicit `--allow-local-test-only` mode, denial of private routes and the 1/5/10/19 client limit.

For the HTTP staging Caddy listener on PC loopback, run:

~~~powershell
node ./scripts/test-vps-smoke.mjs --local-only --base-url http://127.0.0.1:8089 --skip-ekaiwa
~~~

Local staging can match wildcard Host values, so this mode skips only forged-Host **homepage** probes. It still checks forged-Host admin paths, every other private path, method restrictions and catalog rights before starting the benchmark. The public HTTPS tests below keep **all** forged-Host checks, including homepage rejection.

## 2. Inspect VPS loopback services (operator, read-only)

On the VPS, from a controlled SSH session:

~~~sh
ss -ltn
curl --fail --silent --show-error --output /dev/null --write-out 'web %{http_code} %{time_total}s\n' http://127.0.0.1:3100/
curl --fail --silent --show-error --output /dev/null --write-out 'api %{http_code} %{time_total}s\n' http://127.0.0.1:4100/api/catalog
curl --fail --silent --show-error --output /dev/null --write-out 'ekaiwa-upstream %{http_code} %{time_total}s\n' http://127.0.0.1:7860/
free -m
~~~

Review ss output manually: PostgreSQL must listen only on 127.0.0.1:5432 (and possibly ::1 if configured), Next on loopback 3100, Fastify on loopback 4100; none of 5432, 3100, 4100 may bind on public interfaces. Existing E-KAIWA service must remain reachable. Admin is **intentionally** reachable from localhost with normal authentication; direct loopback requests are **not** a test of the public Caddy deny rules.

From an independent client, test that the internet cannot connect directly to 5432, 3100, 4100 or Neo port 9010; use a bounded TCP check rather than exposing those ports for testing. If host firewall rules are in question, inspect them read-only. Do not read or print credentials.

## 3. Exercise Caddy through the real public hostname before DNS cutover

Use the canonical hostname and connect directly to the existing VPS IP, preserving TLS SNI, Host, and certificate validation:

~~~powershell
curl.exe --resolve mitajapanshop.duckdns.org:443:217.142.225.255 -I https://mitajapanshop.duckdns.org/
node ./scripts/test-vps-smoke.mjs --connect-ip 217.142.225.255 --check-http-redirect --report ./deploy/mita/qa-canary-result.json
~~~

This requires Caddy to serve a valid certificate for mitajapanshop.duckdns.org even before DNS cutover. **Do not add -k, disable certificate verification, change DuckDNS, or change Caddy to make a failing test pass.** If certificate issuance is not yet possible, record the TLS failure and postpone public acceptance until the certificate is genuinely valid.

After cutover, replace --connect-ip 217.142.225.255 with --live-dns and choose a fresh report filename. If the owner has switched **OFF** the Admin option *Ẩn sản phẩm local_test_only* (the current production default), append `--allow-local-test-only` to reflect this explicit publication policy; without this flag QA deliberately refuses such rows. Never use --live-dns before DNS points to the intended VPS. Only append --max-p95-ms N and --ekaiwa-max-p95-ms N once the owner has approved those latency thresholds. Files supplied to --report must be new paths; the command refuses to overwrite existing evidence.

The test covers:

- public HTML: home, catalog, category pages, purchase guide, cart, and first eligible public product detail if available;
- public API: categories, catalog, GET/HEAD, valid detail JSON, invalid query, missing product; every returned product and variant must have rightsStatus=verified by default, or verified/local_test_only when the explicit QA flag is provided; unverified remains forbidden;
- private admin, sync status, health, checkout, unknown API methods and paths; tests encoded private paths, forged Host (localhost:3100, 127.0.0.1:3100, evil.invalid) and forged Origin;
- Caddy response protections: X-Content-Type-Options: nosniff, a Referrer-Policy, and either anti-framing header or CSP frame-ancestors;
- benchmark four sequential stages **1, 5, 10, 19 concurrent GET clients**, with 100 or more requests per stage, capped at 19 in flight, on public pages and catalog endpoints;
- remote https://ekaiwa.duckdns.org/ read-only probes before, between and after each stage; status drift or unsuccessful response fails QA, and latency p50/p95/p99 is recorded.

POST checkout sends only the invalid empty JSON object {}; no valid order details and no admin credentials are sent. Benchmark traffic consists solely of GET requests. No Amazon retrieval, worker startup, DB mutation, or import job is attempted.

## 4. Review live resource and E-KAIWA safety

Run resource monitoring **during** the staged benchmark, not just afterward. Example read-only commands from a separate VPS SSH session:

~~~sh
vmstat 1 60
free -m
ps -eo pid,rss,%mem,%cpu,args --sort=-rss | head -n 20
ss -tan | grep -E ':5432|:3100|:4100|:7860'
journalctl -k --since '15 min ago' --no-pager | grep -Ei 'oom|out.of.memory|killed.process'
~~~

If privileged PostgreSQL read-only access already exists, inspect connection saturation using SELECT state, count(*) FROM pg_stat_activity GROUP BY state; and check VPS disk/storage health. Capture an idle baseline first; repeat measurements under 19 clients, at test completion, and after normal idle recovery. Check that E-KAIWA is responsive and that Hermes/cron workloads and the system Node runtime have not changed. A healthy HTTP code alone does **not** prove E-KAIWA performance is unaffected.

**STOP before DNS cutover** if any private route becomes reachable, an `unverified` product appears, local_test_only appears while the Admin hide switch is ON, 19-client tests have HTTP errors/timeouts, sustained swap-in/out or OOM occurs, PostgreSQL exhausts its connections, or E-KAIWA/Hermes behavior materially degrades. Do not upgrade the VPS, restart unrelated services, adjust global Node, or widen DB exposure. The owner explicitly authorized showing `local_test_only` with switch OFF; this is not permission to violate third-party image/text rights. The rollout explicitly has **no backups**, so do not create backups or perform restore tests as part of QA.

The gate produces per-case PASS/FAIL output, per-stage request count/error count/p50/p95/p99 and an optional JSON report. The report only establishes behavior at the time of the test. Record the companion RAM/swap/process/PG and E-KAIWA readings with timestamps when deciding whether to proceed.
