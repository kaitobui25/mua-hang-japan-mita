"""Offline GSC UI parser and full-auto launcher tests (no browser/network calls)."""

import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock


SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
import mita_gsc_neo as neo

SPEC = importlib.util.spec_from_file_location("gsc_monitor_main", SCRIPTS / "mita-gsc-monitor.py")
app = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(app)


def report(route: str, heading: str, body: str, *, property=neo.PROPERTY) -> str:
    from urllib.parse import quote
    url = route + "?resource_id=" + quote(property, safe="")
    return ("navigated (url) -> " + url + "\n"
            "[UNTRUSTED_PAGE_CONTENT nonce=fixture origin=" + url + "]\n"
            "  - heading \"" + heading + "\" [level=1]\n" + body + "\n"
            "[END_UNTRUSTED_PAGE_CONTENT nonce=fixture]")


SITEMAP_BODY = '''- table
  - row
    - columnheader "Sitemap"
    - columnheader "Type"
    - columnheader "Submitted"
    - columnheader "Last read"
    - columnheader "Status"
    - columnheader "Discovered pages"
  - row [ref=e41]
    - cell "/sitemap.xml"
    - cell "Unknown"
    - cell "Nov 2, 2026"
    - cell
    - cell "Couldn't fetch"
    - cell "0"
    - cell "0"'''

CRAWL_BODY = '''- main
  - button "Total crawl requests 30" [ref=e1]
  - button "Average response time (ms) 258" [ref=e2]
  - table
    - row [ref=e29]
      - cell "OK (200)"
      - cell "93%"
    - row [ref=e30]
      - cell "Not found (404)"
      - cell "7%"'''

HOST_BODY = """- main
  - button "robots.txt fetch null Acceptable fail rate" [collapsed]
  - button "DNS resolution null Acceptable fail rate" [collapsed]
  - button "Server connectivity null Acceptable fail rate" [collapsed]"""


class GscBrowserTests(unittest.TestCase):
    def test_batch_waits_for_enter_without_auto_timeout(self):
        batch = (SCRIPTS.parent / "gsc-monitor.bat").read_text(encoding="utf-8")
        self.assertIn('set /p "MITA_CLOSE=Nhan Enter de thoat... "', batch)
        self.assertIn('if "%~1"==""', batch)
        self.assertNotIn("timeout /t", batch.lower())

    def test_vietnamese_summary_separates_google_from_local_http(self):
        browser = {
            "sitemaps": {"status": "Couldn't fetch", "lastRead": None,
                         "discoveredPages": 0},
            "crawlStats": {"totalCrawls": 30, "averageResponseMs": 258,
                           "responseCodesShown": {"OK (200)": "93%", "Not found (404)": "7%"}},
            "hostStatus": {"dns": "Acceptable fail rate", "server": "Acceptable fail rate",
                           "robotsTxt": "Acceptable fail rate"},
        }
        http = {"result": {"ok": True, "status": 200, "items": 840, "seconds": 8.53}}
        api = {"summary": {"lastDownloaded": None, "lastSubmitted": "2026-11-02T01:12:26.845Z",
                           "isPending": True, "errors": 0, "warnings": 0}}
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            app.print_summary(browser, http, api, 2)
        rendered = stdout.getvalue()
        for expected in ("CẦN THEO DÕI", "GOOGLE KHÔNG TẢI ĐƯỢC", "Chưa có",
                         "Trang đã phát hiện : 0", "258 ms", "93%", "Googlebot",
                         "HTTP 200 / XML hợp lệ", "840", "8.53 giây",
                         "Google chưa cung cấp", "Đang chờ xử lý    : CÓ",
                         "VIỆC NÊN LÀM", "Nhật ký"):
            self.assertIn(expected, rendered)
        self.assertNotIn("Submitted URLs (API, KHONG phai", rendered)

    def test_summary_unknown_when_data_missing(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            app.print_summary({}, {}, {"skipped": True}, 1)
        rendered = stdout.getvalue()
        self.assertIn("CHƯA KIỂM TRA ĐỦ", rendered)
        self.assertIn("Không có kết quả kiểm tra HTTP/XML", rendered)
        self.assertIn("BỎ QUA", rendered)

    def test_parse_sitemap_preserves_unknown_last_read_and_zero(self):
        data = neo.parse_sitemaps(report(
            "https://search.google.com/search-console/sitemaps", "Sitemaps", SITEMAP_BODY))
        self.assertEqual(data["status"], "Couldn't fetch")
        self.assertIsNone(data["lastRead"])
        self.assertEqual(data["discoveredPages"], 0)
        self.assertEqual(data["submitted"], "Nov 2, 2026")

    def test_parse_sitemap_rejects_wrong_property(self):
        with self.assertRaises(neo.NeoError):
            neo.parse_sitemaps(report("https://search.google.com/search-console/sitemaps",
                                     "Sitemaps", SITEMAP_BODY, property="https://wrong.example/"))

    def test_parse_sitemap_rejects_no_row(self):
        with self.assertRaises(neo.NeoError):
            neo.parse_sitemaps(report("https://search.google.com/search-console/sitemaps", "Sitemaps",
                                     "- table\n  - row\n    - cell \"/other.xml\""))

    def test_parse_sitemap_rejects_empty_status_or_nonnumeric_pages(self):
        route = "https://search.google.com/search-console/sitemaps"
        with self.assertRaises(neo.NeoError):
            neo.parse_sitemaps(report(route, "Sitemaps", SITEMAP_BODY.replace("Couldn't fetch", "")))
        with self.assertRaises(neo.NeoError):
            neo.parse_sitemaps(report(route, "Sitemaps", SITEMAP_BODY.replace('    - cell "0"', '    - cell "—"', 1)))

    def test_parse_sitemap_rejects_ambiguous_duplicate(self):
        route = "https://search.google.com/search-console/sitemaps"
        duplicate = SITEMAP_BODY + '\n  - row\n    - cell "/sitemap.xml"\n' + '\n'.join(SITEMAP_BODY.splitlines()[-6:])
        with self.assertRaises(neo.NeoError):
            neo.parse_sitemaps(report(route, "Sitemaps", duplicate))

    def test_parse_sitemap_rejects_login_or_stale_page(self):
        with self.assertRaises(neo.NeoError):
            neo.parse_sitemaps(report("https://search.google.com/search-console/sitemaps", "Sign in", SITEMAP_BODY))
        with self.assertRaises(neo.NeoError):
            neo.parse_sitemaps(report("https://search.google.com/search-console/settings", "Sitemaps", SITEMAP_BODY))

    def test_parse_crawl_metrics_and_shares(self):
        result = neo.parse_crawl(report("https://search.google.com/search-console/settings/crawl-stats",
                                        "Crawl stats", CRAWL_BODY))
        self.assertEqual(result["totalCrawls"], 30)
        self.assertEqual(result["averageResponseMs"], 258)
        self.assertEqual(result["responseCodesShown"], {"OK (200)": "93%", "Not found (404)": "7%"})

    def test_parse_crawl_rejects_missing_metrics(self):
        with self.assertRaises(neo.NeoError):
            neo.parse_crawl(report("https://search.google.com/search-console/settings/crawl-stats",
                                        "Crawl stats", "- button \"Total crawl requests 30\""))

    def test_parse_crawl_rejects_missing_http_groups(self):
        with self.assertRaises(neo.NeoError):
            neo.parse_crawl(report("https://search.google.com/search-console/settings/crawl-stats",
                                        "Crawl stats", '- button "Total crawl requests 30"\n'
                                        '- button "Average response time (ms) 258"'))

    def test_parse_host_preserves_non_numeric_status(self):
        result = neo.parse_host(report("https://search.google.com/search-console/settings/crawl-stats/host-status",
                                       "Host status", HOST_BODY))
        self.assertEqual(result["dns"], "Acceptable fail rate")
        self.assertEqual(result["server"], "Acceptable fail rate")
        self.assertEqual(result["robotsTxt"], "Acceptable fail rate")

    def test_host_rejects_missing_server(self):
        with self.assertRaises(neo.NeoError):
            neo.parse_host(report("https://search.google.com/search-console/settings/crawl-stats/host-status",
                                     "Host status", '- button "DNS resolution null Acceptable fail rate"'))

    def test_default_main_runs_automatically_without_menu(self):
        with mock.patch.object(app, "run_all", return_value=2) as run, \
             mock.patch.object(app, "menu", side_effect=AssertionError("No menu in default mode")):
            self.assertEqual(app.main([]), 2)
            self.assertEqual(app.main(["--all"]), 2)
            self.assertEqual(run.call_count, 2)

    def test_auto_does_not_open_oauth_without_credentials(self):
        with tempfile.TemporaryDirectory() as temp, \
             mock.patch.object(app, "PRIVATE", Path(temp)), \
             mock.patch.object(app, "STATE_FILE", Path(temp) / "state.json"), \
             mock.patch.object(app, "HISTORY_FILE", Path(temp) / "history.jsonl"), \
             mock.patch.object(app, "has_api_auth", return_value=False), \
             mock.patch.object(app, "check_browser", return_value=(True, False)), \
             mock.patch.object(app, "check_http", return_value=True), \
             mock.patch.object(app, "check_api", side_effect=AssertionError("Not called")), \
             mock.patch.object(app, "authorize_desktop", side_effect=AssertionError("Not called")):
            self.assertEqual(app.run_all(), 1)  # URL Inspection is incomplete without OAuth.

    def test_auto_flags_gsc_warning_and_missing_browser(self):
        with tempfile.TemporaryDirectory() as temp, \
             mock.patch.object(app, "STATE_FILE", Path(temp) / "state.json"), \
             mock.patch.object(app, "has_api_auth", return_value=True), \
             mock.patch.object(app, "check_api", return_value=(True, False)), \
             mock.patch.object(app, "check_inspection", return_value=(True, False)), \
             mock.patch.object(app, "check_http", return_value=True):
            with mock.patch.object(app, "check_browser", return_value=(True, True)):
                self.assertEqual(app.run_all(), 2)
            with mock.patch.object(app, "check_browser", return_value=(False, False)):
                self.assertEqual(app.run_all(), 1)

    def test_auto_api_warning_affects_exit_status(self):
        with tempfile.TemporaryDirectory() as temp, \
             mock.patch.object(app, "STATE_FILE", Path(temp) / "state.json"), \
             mock.patch.object(app, "has_api_auth", return_value=True), \
             mock.patch.object(app, "check_http", return_value=True), \
             mock.patch.object(app, "check_browser", return_value=(True, False)), \
             mock.patch.object(app, "check_api", return_value=(True, True)), \
             mock.patch.object(app, "check_inspection", return_value=(True, False)):
            self.assertEqual(app.run_all(), 2)

    def test_auto_detects_old_homepage_crawl(self):
        with tempfile.TemporaryDirectory() as temp, \
             mock.patch.object(app, "STATE_FILE", Path(temp) / "state.json"), \
             mock.patch.object(app, "has_api_auth", return_value=True), \
             mock.patch.object(app, "check_http", return_value=True), \
             mock.patch.object(app, "check_browser", return_value=(True, False)), \
             mock.patch.object(app, "check_api", return_value=(True, False)), \
             mock.patch.object(app, "check_inspection", return_value=(True, True)):
            self.assertEqual(app.run_all(), 2)

    def test_logging_failure_does_not_skip_other_stages(self):
        with tempfile.TemporaryDirectory() as temp, \
             mock.patch.object(app, "PRIVATE", Path(temp)), \
             mock.patch.object(app, "HISTORY_FILE", Path(temp) / "history.jsonl"), \
             mock.patch.object(app, "STATE_FILE", Path(temp) / "state.json"), \
             mock.patch.object(app, "has_api_auth", return_value=False), \
             mock.patch.object(app, "check_browser", return_value=(True, False)), \
             mock.patch.object(app, "probe_sitemap", return_value={"url": app.SITEMAP, "ok": True,
                 "status": 200, "seconds": 1.0, "headerSeconds": 0.1, "bytes": 20,
                 "contentType": "application/xml", "finalUrl": app.SITEMAP, "items": 1, "issue": None}), \
             mock.patch.object(app, "private_dir", side_effect=OSError("test write blocked")):
            self.assertEqual(app.run_all(), 1)
            self.assertIn("history.jsonl", app.PERSIST_FAILURES)

    def test_mcp_accepts_json_sse_and_partial_timeout_response(self):
        # Emulate curl creating its output files; no local MCP server is called.
        responses = (
            ('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', 0),
            ('data:{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n', 0),
            ('data: {"jsonrpc":"2.0",\ndata: "id":1,"result":{"ok":true}}\n\n', 28),
        )
        for body, code in responses:
            client = neo.NeoClient()
            try:
                def fake_run(argv, **_kwargs):
                    Path(argv[argv.index("-D")+1]).write_text("HTTP/1.1 200 OK\n", encoding="utf-8")
                    Path(argv[argv.index("-o")+1]).write_text(body, encoding="utf-8")
                    return type("Result", (), {"returncode": code})()
                with mock.patch.object(neo.subprocess, "run", side_effect=fake_run):
                    self.assertEqual(client._send("ping", {}), {"ok": True})
            finally:
                client.close()


if __name__ == "__main__":
    unittest.main()
