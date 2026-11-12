"""Offline unit tests: no Google login, production request, or stateful service call."""

import importlib.util
import base64
import hashlib
import http.client
import json
from datetime import datetime, timezone
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest import mock
import urllib.error
import urllib.parse
import urllib.request


PATH = Path(__file__).with_name("mita-gsc-monitor.py")
SPEC = importlib.util.spec_from_file_location("mita_gsc_monitor", PATH)
app = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(app)
VALID_XML = (b'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
             b'<url><loc>https://example.org/</loc></url></urlset>')


class MockResponse:
    status = 200

    def __init__(self, body, content_type="application/xml", final_url=app.SITEMAP):
        self.body = body
        self.headers = {"Content-Type": content_type}
        self.final_url = final_url

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def geturl(self):
        return self.final_url

    def read(self, amount=-1):
        return self.body if amount < 0 else self.body[:amount]


class MockOpener:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if self.error:
            raise self.error
        return self.response


class GscMonitorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.patches = [
            mock.patch.object(app, "PRIVATE", root),
            mock.patch.object(app, "STATE_FILE", root / "state.json"),
            mock.patch.object(app, "HISTORY_FILE", root / "history.jsonl"),
            mock.patch.object(app, "CLIENT_FILE", root / "oauth-client.json"),
            mock.patch.object(app, "TOKEN_FILE", root / "oauth-refresh.dpapi"),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in reversed(self.patches):
            patch.stop()
        self.tmp.cleanup()

    def probe(self, response=None, error=None):
        opener = MockOpener(response, error)
        with mock.patch.object(app.urllib.request, "build_opener", return_value=opener):
            result = app.probe_sitemap()
        return result, opener

    def test_http_valid_xml_and_status(self):
        result, opener = self.probe(MockResponse(VALID_XML))
        self.assertTrue(result["ok"])
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["items"], 1)
        self.assertEqual(opener.requests[0][0].get_method(), "GET")
        self.assertEqual(opener.requests[0][1], 25)

    def test_http_200_html_is_not_success(self):
        result, _ = self.probe(MockResponse(b"<html>captcha</html>", "text/html"))
        self.assertFalse(result["ok"])
        self.assertIn("Content-Type", result["issue"])

    def test_http_invalid_xml_is_not_success(self):
        result, _ = self.probe(MockResponse(b"<urlset>"))
        self.assertFalse(result["ok"])
        self.assertIn("XML sitemap", result["issue"])

    def test_http_wrong_xml_namespace_is_not_success(self):
        result, _ = self.probe(MockResponse(b"<html></html>"))
        self.assertFalse(result["ok"])

    def test_http_oversize_is_not_success(self):
        result, _ = self.probe(MockResponse(b"a" * (app.MAX_XML_BYTES + 3)))
        self.assertFalse(result["ok"])
        self.assertIn("4 MiB", result["issue"])

    def test_http_403_error_is_recorded_not_treated_as_xml(self):
        exc = urllib.error.HTTPError(app.SITEMAP, 403, "Forbidden", {}, None)
        result, _ = self.probe(error=exc)
        self.assertEqual(result["status"], 403)
        self.assertFalse(result["ok"])

    def test_network_error_is_not_zero_status(self):
        result, _ = self.probe(error=urllib.error.URLError("dns"))
        self.assertIsNone(result["status"])
        self.assertFalse(result["ok"])

    def test_http_incomplete_stream_is_not_success(self):
        response = MockResponse(VALID_XML)
        response.read = mock.Mock(side_effect=http.client.IncompleteRead(b"<urlset>", 100))
        result, _ = self.probe(response)
        self.assertFalse(result["ok"])
        self.assertIn("IncompleteRead", result["issue"])

    def test_redirect_outside_original_host_refused(self):
        handler = app._SameHostRedirect()
        request = urllib.request.Request(app.SITEMAP)
        with self.assertRaises(RuntimeError):
            handler.redirect_request(request, None, 302, "Found", {}, "http://127.0.0.1/private")
        with self.assertRaises(RuntimeError):
            handler.redirect_request(request, None, 302, "Found", {}, "https://another-site.example/path")

    def test_http_history_and_change_detection(self):
        ok = {"url": app.SITEMAP, "ok": True, "status": 200, "seconds": 1.0,
              "headerSeconds": .1, "bytes": 10, "contentType": "application/xml",
              "finalUrl": app.SITEMAP, "items": 1, "issue": None}
        with mock.patch.object(app, "probe_sitemap", side_effect=[ok, {**ok, "ok": False, "status": 500, "issue": "HTTP 500"}]):
            self.assertTrue(app.check_http())
            self.assertFalse(app.check_http())
        entries = [json.loads(line) for line in app.HISTORY_FILE.read_text(encoding="utf-8").splitlines()]
        self.assertEqual(len(entries), 2)
        self.assertFalse(entries[1]["ok"])
        self.assertTrue(any("thay doi" in x for x in entries[1]["alerts"]))

    def test_api_missing_fields_are_unknown_not_zero(self):
        value = app.summarize_resource({"path": app.SITEMAP})
        self.assertIsNone(value["lastDownloaded"])
        self.assertIsNone(value["errors"])
        self.assertIsNone(value["submittedInApi"])
        self.assertNotIn("discoveredPages", value)
        self.assertNotIn("status", value)

    def test_api_numeric_strings_and_submitted_not_discovered(self):
        value = app.summarize_resource({"path": app.SITEMAP, "errors": "0", "warnings": "2",
                                        "isPending": False, "contents": [{"submitted": "832"}, {"submitted": "5"}]})
        self.assertEqual(value["submittedInApi"], 837)
        self.assertEqual(value["errors"], 0)
        self.assertEqual(value["warnings"], 2)
        self.assertFalse(value["isPending"])

    def test_api_changes_only_after_baseline(self):
        earlier = {"lastDownloaded": None, "isPending": True, "errors": 0, "warnings": 0, "submittedInApi": 832}
        current = {**earlier, "lastDownloaded": "2026-11-06T00:00:00Z", "isPending": False}
        self.assertEqual(app.compare_api(None, earlier), [])
        alerts = app.compare_api(earlier, current)
        self.assertEqual(len(alerts), 2)

    def test_api_get_only_and_exact_property_path(self):
        resource = {"path": app.SITEMAP, "lastDownloaded": "2026-11-05T00:00:00Z"}
        opener = MockOpener(MockResponse(json.dumps(resource).encode("utf-8"), "application/json"))
        with mock.patch.object(app, "api_access_token", return_value="TEST_TOKEN"), \
             mock.patch.object(app.urllib.request, "build_opener", return_value=opener):
            self.assertEqual(app.api_sitemap_resource(), resource)
        request = opener.requests[0][0]
        self.assertEqual(request.get_method(), "GET")
        self.assertIn("sites/https%3A%2F%2Fmitajapanshop.duckdns.org%2F/sitemaps/", request.full_url)

    def test_api_wrong_sitemap_path_fails_closed(self):
        opener = MockOpener(MockResponse(b'{"path":"https://wrong.example/sitemap.xml"}'))
        with mock.patch.object(app, "api_access_token", return_value="TEST_TOKEN"), \
             mock.patch.object(app.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(ValueError):
                app.api_sitemap_resource()

    def test_inspection_post_is_readonly_query_for_exact_homepage(self):
        payload = {"inspectionResult": {"indexStatusResult": {
            "verdict": "PASS", "lastCrawlTime": "2026-11-02T00:37:57Z"}}}
        opener = MockOpener(MockResponse(json.dumps(payload).encode("utf-8"), "application/json"))
        with mock.patch.object(app, "api_access_token", return_value="TEST_TOKEN"), \
             mock.patch.object(app.urllib.request, "build_opener", return_value=opener):
            self.assertEqual(app.api_inspection_resource(), payload["inspectionResult"]["indexStatusResult"])
        request = opener.requests[0][0]
        self.assertEqual(request.get_method(), "POST")  # URL Inspection's read-only query method.
        self.assertEqual(request.full_url, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect")
        self.assertEqual(json.loads(request.data), {"inspectionUrl": app.SITE, "siteUrl": app.SITE})
        self.assertEqual(request.headers["Authorization"], "Bearer TEST_TOKEN")
        self.assertEqual(app.SCOPE, "https://www.googleapis.com/auth/webmasters.readonly")

    def test_inspection_rejects_missing_index_result_and_bad_timestamp(self):
        opener = MockOpener(MockResponse(b'{"inspectionResult":{}}', "application/json"))
        with mock.patch.object(app, "api_access_token", return_value="TEST_TOKEN"), \
             mock.patch.object(app.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(ValueError):
                app.api_inspection_resource()
        opener = MockOpener(MockResponse(b'{"inspectionResult":[]}', "application/json"))
        with mock.patch.object(app, "api_access_token", return_value="TEST_TOKEN"), \
             mock.patch.object(app.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(ValueError):
                app.api_inspection_resource()
        with self.assertRaises(ValueError):
            app.summarize_inspection({"lastCrawlTime": "not-a-date"})

    def test_inspection_distinguishes_old_recent_and_unknown(self):
        now = datetime(2026, 11, 12, 1, 40, tzinfo=timezone.utc)
        before = {"lastCrawlTime": "2026-11-02T00:37:57Z"}
        recent = {"lastCrawlTime": "2026-11-11T00:37:57Z"}
        stale = {"lastCrawlTime": "2026-11-06T03:00:00Z"}
        self.assertEqual(app.assess_inspection(before, now=now)[0], "BEFORE_SEO")
        self.assertEqual(app.assess_inspection(recent, now=now)[0], "RECENT")
        self.assertEqual(app.assess_inspection(stale, max_age_days=5, now=now)[0], "STALE")
        self.assertEqual(app.assess_inspection({}, now=now)[0], "UNKNOWN")

    def test_inspection_logs_indexed_last_crawl_and_change(self):
        indexed = {"lastCrawlTime": "2026-11-02T00:37:57Z", "verdict": "PASS"}
        latest = {"lastCrawlTime": "2026-11-11T00:37:57Z", "verdict": "PASS"}
        first, second = {}, {}
        with mock.patch.object(app, "api_inspection_resource", side_effect=[indexed, latest]):
            self.assertEqual(app.check_inspection(quiet=True, report_out=first), (True, True))
            self.assertEqual(app.check_inspection(quiet=True, report_out=second), (True, False))
        self.assertEqual(first["status"], "BEFORE_SEO")
        self.assertEqual(second["status"], "RECENT")
        self.assertTrue(second["summary"]["crawlChanged"])
        self.assertEqual(app.read_state()["urlInspection"]["lastCrawlTime"], latest["lastCrawlTime"])
        self.assertNotIn("crawlChanged", app.read_state()["urlInspection"])
        entries = [json.loads(line) for line in app.HISTORY_FILE.read_text(encoding="utf-8").splitlines()]
        self.assertEqual([item["source"] for item in entries], ["gsc-url-inspection"] * 2)

    def test_inspection_api_error_keeps_previous_good_state(self):
        app.write_state({"urlInspection": {"lastCrawlTime": "2026-11-02T00:37:57Z"}})
        with mock.patch.object(app, "api_inspection_resource", side_effect=RuntimeError("offline")):
            self.assertEqual(app.check_inspection(quiet=True), (False, False))
        self.assertEqual(app.read_state()["urlInspection"]["lastCrawlTime"], "2026-11-02T00:37:57Z")

    def test_missing_last_crawl_is_unknown_not_healthy(self):
        result = {}
        with mock.patch.object(app, "api_inspection_resource", return_value={"verdict": "NEUTRAL"}):
            self.assertEqual(app.check_inspection(quiet=True, report_out=result), (False, True))
        self.assertEqual(result["status"], "UNKNOWN")
        self.assertIsNone(result["summary"]["lastCrawlTime"])

    def test_inspect_cli_respects_age_threshold_and_warning_exit(self):
        with mock.patch.object(app, "check_inspection", return_value=(True, True)) as inspect:
            self.assertEqual(app.main(["--inspect", "--max-crawl-age-days", "14"]), 2)
        inspect.assert_called_once_with(max_age_days=14)
        with mock.patch.object(app, "check_inspection", return_value=(False, False)):
            self.assertEqual(app.main(["--inspect"]), 1)

    def test_api_error_does_not_overwrite_last_good(self):
        original = {"gsc": {"lastDownloaded": "2026-11-04T00:00:00Z"}}
        app.write_state(original)
        with mock.patch.object(app, "api_sitemap_resource", side_effect=RuntimeError("expired token")):
            self.assertFalse(app.check_api())
        self.assertEqual(app.read_state(), original)

    def test_oauth_scope_is_readonly_and_api_get_uses_no_write(self):
        self.assertEqual(app.SCOPE, "https://www.googleapis.com/auth/webmasters.readonly")
        self.assertTrue(app.API_URL.startswith("https://www.googleapis.com/webmasters/v3/"))
        self.assertNotIn("submit", app.API_URL)
        self.assertTrue(app.INSPECTION_API_URL.endswith("/urlInspection/index:inspect"))

    @unittest.skipUnless(sys.platform == "win32", "Windows DPAPI is not available")
    def test_dpapi_roundtrip(self):
        secret = b"not-a-real-refresh-token"
        protected = app._dpapi(secret, True)
        self.assertNotIn(secret, protected)
        self.assertEqual(app._dpapi(protected, False), secret)

    def test_oauth_callback_half_open_connection_times_out(self):
        class Handler(app.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()

            def log_message(self, *_args):
                pass

        with app._OAuthCallbackServer(("127.0.0.1", 0), Handler) as server:
            thread = threading.Thread(target=server.handle_request, daemon=True)
            thread.start()
            with socket.create_connection(("127.0.0.1", server.server_port), timeout=3):
                thread.join(timeout=3.5)
            self.assertFalse(thread.is_alive(), "Half-open callback must not block indefinitely")

    def test_oauth_browser_failure_returns_false(self):
        with mock.patch.object(app, "load_client", return_value={"client_id": "id", "client_secret": "secret"}), \
             mock.patch.object(app.webbrowser, "open", return_value=False):
            self.assertFalse(app.authorize_desktop())

    def test_oauth_denied_does_not_store_token(self):
        def fake_browser(url):
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            callback = qs["redirect_uri"][0] + "?" + urllib.parse.urlencode({
                "state": qs["state"][0], "error": "access_denied"})
            def send_callback():
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(callback, timeout=3) as response:
                    response.read()
            thread = threading.Thread(target=send_callback, daemon=True)
            thread.start()
            return True

        with mock.patch.object(app, "load_client", return_value={"client_id": "id", "client_secret": "secret"}), \
             mock.patch.object(app.webbrowser, "open", side_effect=fake_browser), \
             mock.patch.object(app, "token_request", side_effect=AssertionError("No token request on denied consent")):
            self.assertFalse(app.authorize_desktop())
        self.assertFalse(app.TOKEN_FILE.exists())

    @unittest.skipUnless(sys.platform == "win32", "Windows DPAPI is not available")
    def test_oauth_success_uses_pkce_and_persists_encrypted_refresh(self):
        def fake_browser(url):
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
            self.assertEqual(qs["scope"], [app.SCOPE])
            self.assertEqual(qs["code_challenge_method"], ["S256"])
            callback = qs["redirect_uri"][0] + "?" + urllib.parse.urlencode({
                "state": qs["state"][0], "code": "MOCK_AUTH_CODE"})
            def send_callback():
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                with opener.open(callback, timeout=3) as response:
                    response.read()
            threading.Thread(target=send_callback, daemon=True).start()
            self.oauth_challenge = qs["code_challenge"][0]
            return True

        with mock.patch.object(app, "load_client", return_value={"client_id": "id", "client_secret": "secret"}), \
             mock.patch.object(app.webbrowser, "open", side_effect=fake_browser), \
             mock.patch.object(app, "token_request", return_value={
                 "scope": app.SCOPE, "refresh_token": "MOCK_REFRESH_TOKEN"}) as token_call:
            self.assertTrue(app.authorize_desktop())
        params = token_call.call_args.args[0]
        self.assertEqual(params["grant_type"], "authorization_code")
        expected = base64.urlsafe_b64encode(hashlib.sha256(params["code_verifier"].encode("ascii")).digest()).rstrip(b"=").decode("ascii")
        self.assertEqual(expected, self.oauth_challenge)
        encrypted = app.TOKEN_FILE.read_bytes()
        self.assertNotIn(b"MOCK_REFRESH_TOKEN", encrypted)
        self.assertEqual(app._dpapi(encrypted, False), b"MOCK_REFRESH_TOKEN")

    def test_cli_login_exit_code_matches_oauth_result(self):
        with mock.patch.object(app, "authorize_desktop", return_value=False):
            self.assertEqual(app.main(["--login"]), 1)
        with mock.patch.object(app, "authorize_desktop", return_value=True):
            self.assertEqual(app.main(["--login"]), 0)

    def test_watch_rejects_aggressive_polling(self):
        with self.assertRaises(ValueError):
            app.watch(1)


if __name__ == "__main__":
    unittest.main()
