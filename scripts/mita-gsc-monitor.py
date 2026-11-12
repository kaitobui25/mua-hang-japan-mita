"""Local read-only GSC and sitemap monitor for Mita Japan (Python 3 stdlib only).

The two GSC browser reports are authoritative for UI-only fields. The official
Sitemaps API exposes metadata, NOT the exact UI status or Discovered pages.
Sitemaps API uses GET; URL Inspection API uses a read-only POST query.
OAuth token exchange/refresh also uses POST. No indexing requests are sent.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
from ctypes import wintypes
from datetime import datetime, timedelta, timezone
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import sys
import textwrap
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import xml.etree.ElementTree as ET


# Some Windows terminals default to cp932/cp1252, neither can encode Vietnamese.
# The .bat switches to UTF-8; use UTF-8 for redirected/direct Python runs too.
if sys.platform == "win32":
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8", errors="replace")


SITE = "https://mitajapanshop.duckdns.org/"
SITEMAP = SITE + "sitemap.xml"
SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / ".agents" / "runtime" / "gsc-monitor"
CLIENT_FILE = PRIVATE / "oauth-client.json"
TOKEN_FILE = PRIVATE / "oauth-refresh.dpapi"
HISTORY_FILE = PRIVATE / "history.jsonl"
STATE_FILE = PRIVATE / "state.json"
SLOW_SECONDS = 5.0
MAX_XML_BYTES = 4 * 1024 * 1024
PERSIST_FAILURES = []  # Per-run monitoring must continue even if local log is unwritable.
GSC_SITEMAPS = "https://search.google.com/search-console/sitemaps?" + urllib.parse.urlencode({"resource_id": SITE})
GSC_SETTINGS = "https://search.google.com/search-console/settings?" + urllib.parse.urlencode({"resource_id": SITE})
API_URL = ("https://www.googleapis.com/webmasters/v3/sites/"
           + urllib.parse.quote(SITE, safe="") + "/sitemaps/"
           + urllib.parse.quote(SITEMAP, safe=""))
INSPECTION_API_URL = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect"
# Date of commit 343235f (Mita Japan WebSite metadata), not a Google crawl time.
# Update this marker only when the site's homepage SEO/brand metadata changes again.
SEO_BRAND_UPDATED_AT = "2026-11-06T01:53:17Z"
DEFAULT_MAX_CRAWL_AGE_DAYS = 7


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def private_dir() -> None:
    PRIVATE.mkdir(parents=True, exist_ok=True)


def read_state() -> dict:
    try:
        value = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def write_state(value: dict) -> None:
    try:
        private_dir()
        temp = STATE_FILE.with_suffix(".tmp")
        temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(STATE_FILE)
    except OSError:
        PERSIST_FAILURES.append("state.json")
        print("  [UNKNOWN] Khong ghi duoc state.json (tiep tuc kiem tra)", flush=True)


def append_history(event: dict) -> None:
    try:
        private_dir()
        # Keep the local log bounded; never store response body, OAuth URLs or tokens.
        if HISTORY_FILE.exists() and HISTORY_FILE.stat().st_size > 2 * 1024 * 1024:
            HISTORY_FILE.replace(HISTORY_FILE.with_suffix(".previous.jsonl"))
        with HISTORY_FILE.open("a", encoding="utf-8") as log:
            log.write(json.dumps({"observedAt": utc_now(), "schemaVersion": 1,
                                  "site": SITE, **event}, ensure_ascii=False) + "\n")
    except OSError:
        PERSIST_FAILURES.append("history.jsonl")
        print("  [UNKNOWN] Khong ghi duoc history.jsonl (tiep tuc kiem tra)", flush=True)


def xml_page_count(body: bytes) -> int:
    root = ET.fromstring(body)
    # Reject a successful HTML response, captive portal, or other XML document.
    if root.tag not in ("{http://www.sitemaps.org/schemas/sitemap/0.9}urlset",
                        "{http://www.sitemaps.org/schemas/sitemap/0.9}sitemapindex"):
        raise ValueError("Response khong phai XML sitemap")
    return len(root)


class _SameHostRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        original = urllib.parse.urlsplit(SITEMAP)
        target = urllib.parse.urlsplit(newurl)
        if target.scheme != "https" or target.netloc.lower() != original.netloc.lower():
            raise RuntimeError("Refused sitemap redirect to another origin")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def probe_sitemap() -> dict:
    """Check actual GET response; measurements are from this PC, not Googlebot."""
    start = time.perf_counter()
    result = {"url": SITEMAP, "ok": False, "status": None, "seconds": None,
              "headerSeconds": None, "bytes": None, "contentType": None,
              "finalUrl": None, "items": None, "issue": None}
    try:
        req = urllib.request.Request(SITEMAP, headers={"User-Agent": "MitaGscMonitor/1.0", "Accept": "application/xml,text/xml,*/*"})
        opener = urllib.request.build_opener(_SameHostRedirect)
        with opener.open(req, timeout=25) as resp:
            result["headerSeconds"] = round(time.perf_counter() - start, 3)
            result["status"] = resp.status
            result["contentType"] = resp.headers.get("Content-Type", "")
            result["finalUrl"] = resp.geturl()
            body = resp.read(MAX_XML_BYTES + 1)
        result["seconds"] = round(time.perf_counter() - start, 3)
        result["bytes"] = len(body)
        origin = urllib.parse.urlsplit(result["finalUrl"])
        expected = urllib.parse.urlsplit(SITEMAP)
        if result["status"] != 200:
            result["issue"] = "HTTP status khac 200"
        elif origin.scheme != "https" or origin.netloc.lower() != expected.netloc.lower():
            result["issue"] = "Redirect sang origin khac (khong tin cay)"
        elif len(body) > MAX_XML_BYTES:
            result["issue"] = "XML vuot gioi han 4 MiB"
        elif "xml" not in result["contentType"].lower():
            result["issue"] = "Content-Type khong phai XML"
        else:
            result["items"] = xml_page_count(body)
            result["ok"] = True
    except urllib.error.HTTPError as exc:
        result["status"] = exc.code
        result["issue"] = "HTTP " + str(exc.code)
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        result["issue"] = "Network/DNS/TLS/timeout: " + type(exc).__name__
    except http.client.HTTPException as exc:
        result["issue"] = "HTTP stream bi ngat/chua du: " + type(exc).__name__
    except (ET.ParseError, ValueError) as exc:
        result["issue"] = "XML sitemap khong hop le: " + type(exc).__name__
    except RuntimeError as exc:
        result["issue"] = str(exc)
    result["seconds"] = round(time.perf_counter() - start, 3)
    return result


def check_http(quiet: bool = False, report_out: dict | None = None) -> bool:
    result = probe_sitemap()
    state = read_state()
    before = state.get("http") or {}
    alerts = []
    if before and before.get("ok") != result["ok"]:
        alerts.append("Trang thai HTTP/XML da thay doi")
    if not result["ok"]:
        alerts.append("SITEMAP KHONG DAT: " + str(result["issue"]))
    elif result["seconds"] >= SLOW_SECONDS:
        alerts.append("PHAN HOI CHAM >= 5 giay (do tu PC, khong phai Googlebot)")
    if report_out is not None:
        report_out.update({"result": result, "alerts": alerts})
    if not quiet:
        print("\n[SITEMAP HTTP]", SITEMAP)
        print("  HTTP:", result["status"] if result["status"] is not None else "khong nhan duoc")
        print("  Tong:", result["seconds"], "giay; den headers:", result["headerSeconds"], "giay")
        print("  Dung luong:", result["bytes"], "bytes; XML items:", result["items"])
        print("  Ket qua:", "OK" if result["ok"] else result["issue"])
        for alert in alerts:
            print("  CANH BAO:", alert)
    append_history({"source": "local-http", **result, "alerts": alerts})
    state["http"] = {"ok": result["ok"], "status": result["status"],
                     "seconds": result["seconds"], "observedAt": utc_now()}
    write_state(state)
    return result["ok"]


class _Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(payload: bytes, protect: bool) -> bytes:
    """Encrypt refresh token for the logged-in Windows user; never plain JSON."""
    if sys.platform != "win32":
        raise RuntimeError("OAuth token persistence yeu cau Windows DPAPI")
    buffer = ctypes.create_string_buffer(payload)
    original = _Blob(len(payload), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
    result = _Blob()
    crypt = ctypes.windll.crypt32.CryptProtectData if protect else ctypes.windll.crypt32.CryptUnprotectData
    crypt.argtypes = [ctypes.POINTER(_Blob), ctypes.c_wchar_p, ctypes.c_void_p,
                      ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob)]
    crypt.restype = wintypes.BOOL
    if not crypt(ctypes.byref(original), None, None, None, None, 0, ctypes.byref(result)):
        raise OSError("Windows DPAPI operation failed")
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        free = ctypes.windll.kernel32.LocalFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = ctypes.c_void_p
        free(ctypes.cast(result.pbData, ctypes.c_void_p))


def load_client() -> dict:
    try:
        data = json.loads(CLIENT_FILE.read_text(encoding="utf-8"))["installed"]
        if not data.get("client_id") or not data.get("client_secret"):
            raise ValueError("missing client_id / client_secret")
        return data
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise RuntimeError("Thieu/sai OAuth Desktop JSON. Dat tai " + str(CLIENT_FILE)) from exc


def token_request(params: dict) -> dict:
    req = urllib.request.Request("https://oauth2.googleapis.com/token",
            data=urllib.parse.urlencode(params).encode("ascii"),
            headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    with urllib.request.build_opener(_NoApiRedirect).open(req, timeout=20) as response:
        return json.load(response)


class _OAuthCallbackServer(HTTPServer):
    def get_request(self):
        sock, address = super().get_request()
        # HTTPServer.timeout bounds accept(), not reads from an accepted socket.
        # A half-open localhost connection must not stall OAuth indefinitely.
        sock.settimeout(2.0)
        return sock, address

    def handle_error(self, _request, _client_address):
        pass  # No callback query or OAuth code in tracebacks/logs.


def authorize_desktop() -> bool:
    client = load_client()
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    authorization = {"code": None, "error": None}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            values = urllib.parse.urlsplit(self.path)
            fields = urllib.parse.parse_qs(values.query)
            if values.path != "/callback" or fields.get("state", [None])[0] != state:
                self.send_error(400, "Invalid OAuth callback")
                return
            authorization["code"] = fields.get("code", [None])[0]
            authorization["error"] = fields.get("error", [None])[0]
            body = b"<html><body>Google authorization received. Return to Mita GSC Monitor.</body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass  # Never log OAuth authorization codes or callback query strings.

    with _OAuthCallbackServer(("127.0.0.1", 0), Handler) as server:
        server.timeout = 2
        redirect = "http://127.0.0.1:%d/callback" % server.server_port
        params = {"client_id": client["client_id"], "redirect_uri": redirect,
                  "response_type": "code", "scope": SCOPE, "access_type": "offline",
                  "prompt": "consent", "state": state, "code_challenge": challenge,
                  "code_challenge_method": "S256"}
        url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)
        print("Dang mo Google tren trinh duyet; chi chap nhan quyen Search Console read-only.")
        if not webbrowser.open(url):
            print("Khong mo duoc trinh duyet tu dong. Mo trinh duyet thu cong va chay lai.")
            return False
        end = time.monotonic() + 120
        while time.monotonic() < end and not authorization["code"] and not authorization["error"]:
            server.handle_request()
    if not authorization["code"]:
        print("Khong nhan duoc OAuth code trong 120 giay hoac quyen bi tu choi.")
        return False
    token = token_request({"code": authorization["code"], "client_id": client["client_id"],
                           "client_secret": client["client_secret"], "redirect_uri": redirect,
                           "grant_type": "authorization_code", "code_verifier": verifier})
    if SCOPE not in token.get("scope", SCOPE).split():
        raise RuntimeError("OAuth khong cap scope webmasters.readonly")
    refresh = token.get("refresh_token")
    if not refresh:
        raise RuntimeError("Google khong tra ve refresh token. Can thu OAuth consent lai.")
    private_dir()
    TOKEN_FILE.write_bytes(_dpapi(refresh.encode("utf-8"), protect=True))
    print("Ket noi thanh cong; refresh token ma hoa bang Windows DPAPI, luu ngoai Git.")
    return True


def has_api_auth() -> bool:
    return bool(os.environ.get("MITA_GSC_ACCESS_TOKEN") or TOKEN_FILE.is_file())


def api_access_token() -> str:
    if os.environ.get("MITA_GSC_ACCESS_TOKEN"):
        return os.environ["MITA_GSC_ACCESS_TOKEN"]
    if not TOKEN_FILE.is_file():
        raise RuntimeError("Chua ket noi GSC OAuth (menu 5), hoac dat MITA_GSC_ACCESS_TOKEN")
    client = load_client()
    refresh = _dpapi(TOKEN_FILE.read_bytes(), protect=False).decode("utf-8")
    token = token_request({"client_id": client["client_id"],
                           "client_secret": client["client_secret"],
                           "refresh_token": refresh, "grant_type": "refresh_token"})
    if not token.get("access_token"):
        raise RuntimeError("OAuth refresh khong tra ve access_token")
    return token["access_token"]


class _NoApiRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, _req, _fp, _code, _msg, _headers, _newurl):
        raise RuntimeError("GSC API redirect blocked")


def api_sitemap_resource() -> dict:
    req = urllib.request.Request(API_URL,
            headers={"Authorization": "Bearer " + api_access_token(),
                     "Accept": "application/json", "User-Agent": "MitaGscMonitor/1.0"}, method="GET")
    opener = urllib.request.build_opener(_NoApiRedirect)
    with opener.open(req, timeout=25) as resp:
        data = json.load(resp)
    if not isinstance(data, dict) or data.get("path") != SITEMAP:
        raise ValueError("GSC API returned missing/unexpected sitemap path")
    return data


def api_inspection_resource() -> dict:
    """Read Google-indexed homepage status; POST is required by this read-only API."""
    body = json.dumps({"inspectionUrl": SITE, "siteUrl": SITE}, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(INSPECTION_API_URL, data=body,
            headers={"Authorization": "Bearer " + api_access_token(),
                     "Content-Type": "application/json", "Accept": "application/json",
                     "User-Agent": "MitaGscMonitor/1.0"}, method="POST")
    with urllib.request.build_opener(_NoApiRedirect).open(req, timeout=25) as resp:
        data = json.load(resp)
    inspection = data.get("inspectionResult") if isinstance(data, dict) else None
    status = inspection.get("indexStatusResult") if isinstance(inspection, dict) else None
    if not isinstance(status, dict):
        raise ValueError("URL Inspection missing indexStatusResult")
    return status


def parse_utc_timestamp(value: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError("Missing timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamp lacks timezone")
    return parsed.astimezone(timezone.utc)


def summarize_inspection(status: dict) -> dict:
    """Persist a small, fixed set of index metadata (no Google response body)."""
    crawl = status.get("lastCrawlTime")
    if crawl is not None:
        parse_utc_timestamp(crawl)  # Fail closed on malformed crawl times.
    return {"url": SITE, "lastCrawlTime": crawl, "verdict": status.get("verdict"),
            "coverageState": status.get("coverageState"),
            "pageFetchState": status.get("pageFetchState"),
            "robotsTxtState": status.get("robotsTxtState"),
            "indexingState": status.get("indexingState"),
            "googleCanonical": status.get("googleCanonical")}


def assess_inspection(summary: dict, *, max_age_days: int = DEFAULT_MAX_CRAWL_AGE_DAYS,
                      now: datetime | None = None) -> tuple[str, list[str], int | None]:
    """Dates are for the *indexed* copy, not a live URL Test."""
    if max_age_days < 1:
        raise ValueError("max_age_days must be at least 1")
    value = summary.get("lastCrawlTime")
    if not value:
        return "UNKNOWN", ["Google chưa cung cấp Last crawl của trang chủ"], None
    crawled = parse_utc_timestamp(value)
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    age_days = max(0, (current - crawled).days)
    if crawled < parse_utc_timestamp(SEO_BRAND_UPDATED_AT):
        return "BEFORE_SEO", ["Google chưa crawl trang chủ sau mốc sửa SEO 06/11/2026"], age_days
    if current - crawled >= timedelta(days=max_age_days):
        return "STALE", ["Google chưa crawl lại trang chủ trong %d ngày" % max_age_days], age_days
    return "RECENT", [], age_days


def check_inspection(quiet: bool = False, report_out: dict | None = None,
                     max_age_days: int = DEFAULT_MAX_CRAWL_AGE_DAYS) -> tuple[bool, bool]:
    """Monitor homepage URL Inspection independently of the sitemap API."""
    try:
        summary = summarize_inspection(api_inspection_resource())
        status, alerts, age_days = assess_inspection(summary, max_age_days=max_age_days)
    except (RuntimeError, ValueError, OSError, urllib.error.URLError,
            urllib.error.HTTPError) as exc:
        issue = type(exc).__name__ + (" HTTP " + str(exc.code) if isinstance(exc, urllib.error.HTTPError) else "")
        if report_out is not None:
            report_out.update({"ok": False, "issue": issue})
        if not quiet:
            print("[GSC URL Inspection] [CHUA RO] Khong lay duoc Last crawl:", issue)
        append_history({"source": "gsc-url-inspection", "ok": False, "issue": issue})
        return False, False

    state = read_state()
    previous = state.get("urlInspection") if isinstance(state.get("urlInspection"), dict) else {}
    changed = bool(previous and previous.get("lastCrawlTime") != summary["lastCrawlTime"])
    if changed:
        # A fresh crawl is useful history, not itself a warning.
        summary["crawlChanged"] = True
    if summary.get("verdict") != "PASS":
        alerts.append("Trạng thái index trang chủ chưa xác nhận PASS: " + str(summary.get("verdict") or "chưa rõ"))
    if report_out is not None:
        report_out.update({"ok": status != "UNKNOWN", "summary": summary, "status": status,
                           "ageDays": age_days, "maxAgeDays": max_age_days, "alerts": alerts})
    if not quiet:
        print("[GSC URL Inspection]", SITE)
        labels = {"BEFORE_SEO": "CHƯA CRAWL SAU SỬA SEO", "STALE": "CRAWL ĐÃ CŨ",
                  "RECENT": "ĐÃ CRAWL SAU MỐC SEO", "UNKNOWN": "CHƯA RÕ"}
        print("  Last crawl (Google Index):", _display_time(summary.get("lastCrawlTime")))
        print("  Tuổi dữ liệu:", str(age_days) + " ngày" if age_days is not None else "chưa rõ")
        print("  Trạng thái:", labels[status], "; Index:", summary.get("verdict") or "chưa rõ")
        for alert in alerts:
            print("  CẢNH BÁO:", alert)
    append_history({"source": "gsc-url-inspection", "ok": status != "UNKNOWN",
                    "summary": summary, "status": status, "ageDays": age_days, "alerts": alerts})
    state["urlInspection"] = {key: value for key, value in summary.items() if key != "crawlChanged"}
    write_state(state)
    return status != "UNKNOWN", bool(alerts)


def _numeric(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


def summarize_resource(resource: dict) -> dict:
    contents = resource.get("contents")
    submitted = None
    if isinstance(contents, list) and contents and all(_numeric(item.get("submitted")) is not None
                                                        for item in contents if isinstance(item, dict)):
        if all(isinstance(item, dict) for item in contents):
            submitted = sum(_numeric(item["submitted"]) for item in contents)
    return {"path": resource.get("path"), "lastDownloaded": resource.get("lastDownloaded"),
            "lastSubmitted": resource.get("lastSubmitted"),
            "isPending": resource.get("isPending") if isinstance(resource.get("isPending"), bool) else None,
            "errors": _numeric(resource.get("errors")), "warnings": _numeric(resource.get("warnings")),
            "submittedInApi": submitted, "type": resource.get("type")}


def compare_api(before: dict | None, current: dict) -> list[str]:
    alerts = []
    if before is None:
        return alerts  # First read is baseline; do not invent change alerts.
    for key, label in (("lastDownloaded", "Google lastDownloaded"),
                       ("isPending", "Trang thai pending"), ("errors", "So loi sitemap"),
                       ("warnings", "So warning"), ("submittedInApi", "Submitted URL theo API")):
        if before.get(key) != current.get(key):
            alerts.append(label + " thay doi: " + str(before.get(key)) + " -> " + str(current.get(key)))
    return alerts


def check_api(quiet: bool = False, with_alerts: bool = False,
              report_out: dict | None = None):
    try:
        current = summarize_resource(api_sitemap_resource())
    except (RuntimeError, ValueError, OSError, urllib.error.URLError,
            urllib.error.HTTPError) as exc:
        # Do not print Google API response bodies or access tokens.
        status = " HTTP " + str(exc.code) if isinstance(exc, urllib.error.HTTPError) else ""
        if report_out is not None:
            report_out.update({"ok": False, "issue": type(exc).__name__ + status})
        if not quiet:
            print("\n[GSC API] Khong lay duoc du lieu:", type(exc).__name__ + status)
            if not has_api_auth():
                print("  Chua lien ket OAuth. Dung gsc-monitor.bat --login de cap quyen.")
        append_history({"source": "gsc-api", "ok": False,
                        "issue": type(exc).__name__ + status})
        return (False, False) if with_alerts else False
    state = read_state()
    before = state.get("gsc") if isinstance(state.get("gsc"), dict) else None
    alerts = compare_api(before, current)
    if current["errors"] is not None and current["errors"] > 0:
        alerts.append("GSC API ghi nhan loi sitemap > 0")
    if current["isPending"] is True:
        alerts.append("GSC API van dang cho Google xu ly sitemap (pending)")
    if report_out is not None:
        report_out.update({"ok": True, "summary": current, "alerts": alerts})
    if not quiet:
        print("\n[GSC API - READ ONLY]", current["path"])
        print("  Last downloaded:", current["lastDownloaded"] or "Google chua cung cap")
        print("  Last submitted:", current["lastSubmitted"] or "Google chua cung cap")
        print("  Pending:", current["isPending"], "; errors:", current["errors"], "; warnings:", current["warnings"])
        print("  Submitted URLs (API, KHONG phai Discovered pages):", current["submittedInApi"])
        print("  UI Status / Discovered pages: mo GSC -> Sitemaps de xem, khong co trong API nay.")
        for alert in alerts:
            print("  CANH BAO:", alert)
    append_history({"source": "gsc-api", "ok": True, "summary": current, "alerts": alerts})
    state["gsc"] = current  # Only replace the last successfully read API snapshot.
    write_state(state)
    return (True, bool(alerts)) if with_alerts else True


def open_report(url: str, label: str) -> None:
    print("Mo", label, "trong trinh duyet. Can dang nhap Google co quyen GSC Mita Japan.")
    if not webbrowser.open(url):
        print("Khong mo duoc trinh duyet; link:", url)


def check_browser(quiet: bool = False, report_out: dict | None = None) -> tuple[bool, bool]:
    """Read three authenticated GSC UI reports without prompting or clicking."""
    if not quiet:
        print("[BrowserOS Neo] Dang ket noi GSC (chi doc)...", flush=True)
    try:
        from mita_gsc_neo import collect, NeoError
        def progress(section: str) -> None:
            labels = {"sitemaps": "1/6 GSC Sitemaps",
                      "crawlStats": "2/6 GSC Crawl stats",
                      "hostStatus": "3/6 GSC DNS / server"}
            print("[%s] Đang kiểm tra..." % labels[section], flush=True)
        report = collect(progress=progress)
    except (ImportError, OSError, RuntimeError, ValueError) as exc:
        # Avoid printing browser page contents, account info, cookies or tokens.
        if report_out is not None:
            report_out.update({"sitemaps": None, "crawlStats": None,
                               "hostStatus": None, "errors": {"browser": type(exc).__name__}})
        if not quiet:
            print("  [UNKNOWN] Khong doc duoc GSC tu BrowserOS Neo:", type(exc).__name__, flush=True)
        append_history({"source": "gsc-browser-ui", "ok": False, "issue": type(exc).__name__})
        return False, False
    state = read_state()
    if report_out is not None:
        report_out.update(report)
    previous = state.get("gscBrowser") if isinstance(state.get("gscBrowser"), dict) else {}
    current = {}
    alerts = []
    sitemap = report.get("sitemaps")
    if sitemap:
        status = sitemap["status"] or "khong ro"
        if not quiet:
            print("  [GSC Sitemaps] Status=%s; Last read=%s; Discovered pages=%s" % (
                  status, sitemap["lastRead"] or "?",
                  sitemap["discoveredPages"] if sitemap["discoveredPages"] is not None else "?"), flush=True)
        if sitemap["status"] != "Success":
            alerts.append("GSC sitemap chua bao Success: " + status)
        old = previous.get("sitemaps") or {}
        for key in ("status", "lastRead", "discoveredPages"):
            if old and old.get(key) != sitemap.get(key):
                alerts.append("GSC " + key + " thay doi: " + str(old.get(key)) + " -> " + str(sitemap[key]))
        current["sitemaps"] = sitemap
    else:
        if not quiet:
            print("  [UNKNOWN] GSC Sitemaps: khong doc duoc dong sitemap", flush=True)
    crawl = report.get("crawlStats")
    if crawl:
        if not quiet:
            print("  [GSC Crawl stats] %s requests; average Googlebot response=%s ms" % (
                  crawl["totalCrawls"], crawl["averageResponseMs"]), flush=True)
            print("  [GSC HTTP groups] " + ", ".join(
                "%s: %s" % (key, val) for key, val in crawl["responseCodesShown"].items()), flush=True)
        server_errors = [key for key in crawl["responseCodesShown"]
                         if re.search(r"\(5\d\d\)", key)]
        if server_errors:
            alerts.append("GSC Crawl stats hien thi nhom HTTP 5xx: " + ", ".join(server_errors))
        current["crawlStats"] = crawl
    else:
        if not quiet:
            print("  [UNKNOWN] GSC Crawl stats: khong doc duoc", flush=True)
    host = report.get("hostStatus")
    if host:
        if not quiet:
            print("  [GSC Host] DNS=%s; Server=%s; robots.txt=%s" % (
                  host["dns"] or "?", host["server"] or "?", host["robotsTxt"] or "?"), flush=True)
        for key in ("dns", "server", "robotsTxt"):
            val = host.get(key)
            if val and "Acceptable fail rate" not in val:
                alerts.append("GSC Host " + key + " can kiem tra: " + val[:60])
        current["hostStatus"] = host
    else:
        if not quiet:
            print("  [UNKNOWN] GSC Host status: khong doc duoc", flush=True)
    if not quiet:
        for section, reason in report.get("errors", {}).items():
            print("  [UNKNOWN] " + section + ": " + reason[:120], flush=True)
        for alert in alerts:
            print("  [WARN] " + alert, flush=True)
    available = bool(sitemap and crawl and host)
    append_history({"source": "gsc-browser-ui", "ok": available,
                    "summary": current, "alerts": alerts,
                    "unavailable": sorted(report.get("errors", {}))})
    if current:
        state["gscBrowser"] = {**previous, **current}
        write_state(state)
    return available, bool(alerts)


def _display_time(value: str | None) -> str:
    """Format Google ISO dates in this computer's timezone, if parseable."""
    if not value:
        return "Google chưa cung cấp"
    try:
        date = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if date.tzinfo:
            date = date.astimezone()
            return date.strftime("%d/%m/%Y %H:%M") + " (giờ máy)"
    except ValueError:
        pass
    return value[:40]


def print_summary(browser: dict, http: dict, api: dict, outcome: int,
                  inspection: dict | None = None) -> None:
    """Present only the measurements of this run, never stale saved snapshots."""
    sitemap = browser.get("sitemaps")
    crawl = browser.get("crawlStats")
    host = browser.get("hostStatus")
    measured = http.get("result")
    api_data = api.get("summary")
    inspection = inspection or {}
    inspected = inspection.get("summary")
    bar = "=" * 68
    title = {0: "BÌNH THƯỜNG", 1: "CHƯA KIỂM TRA ĐỦ", 2: "CẦN THEO DÕI"}[outcome]
    print("\n" + bar)
    print("  BÁO CÁO KIỂM TRA MITA JAPAN")
    print("  Ngày giờ: " + datetime.now().astimezone().strftime("%d/%m/%Y %H:%M (giờ máy)"))
    print("  KẾT LUẬN: " + title)
    print(bar)

    print("\n1. GOOGLE SEARCH CONSOLE - SITEMAP")
    if sitemap:
        status = sitemap.get("status")
        meaning = {"Success": "ĐÃ ĐỌC THÀNH CÔNG",
                   "Couldn't fetch": "GOOGLE KHÔNG TẢI ĐƯỢC"}.get(status, status or "Chưa rõ")
        print("   Trạng thái Google  : " + meaning)
        print("   Lần đọc gần nhất   : " + (sitemap.get("lastRead") or "Chưa có"))
        print("   Trang đã phát hiện : " + str(sitemap.get("discoveredPages", "Chưa rõ")))
        if status != "Success":
            print("   => Google chưa xác nhận đã đọc sitemap thành công.")
    else:
        print("   [CHƯA RÕ] Không đọc được báo cáo GSC Sitemaps.")

    print("\n2. HOẠT ĐỘNG THU THẬP DỮ LIỆU CỦA GOOGLE")
    if crawl:
        print("   Tổng lượt crawl    : " + str(crawl.get("totalCrawls", "Chưa rõ")))
        print("   Phản hồi trung bình: " + str(crawl.get("averageResponseMs", "Chưa rõ")) + " ms (Googlebot)")
        groups = crawl.get("responseCodesShown") or {}
        print("   Mã HTTP            : " + ("; ".join("%s: %s" % item for item in groups.items()) or "Chưa rõ"))
        print("   => Đây là thống kê crawl của Google, không chỉ riêng sitemap.")
    else:
        print("   [CHƯA RÕ] Không đọc được báo cáo Crawl stats.")

    print("\n3. KẾT NỐI TỪ PHÍA GOOGLE")
    if host:
        for name, key in (("DNS", "dns"), ("Máy chủ", "server"), ("robots.txt", "robotsTxt")):
            val = host.get(key)
            label = "Trong mức lỗi Google chấp nhận" if val == "Acceptable fail rate" else (val or "Chưa rõ")
            print("   %-19s: %s" % (name, label))
        print("   => 'Chấp nhận' không có nghĩa là không có lỗi.")
    else:
        print("   [CHƯA RÕ] Không đọc được trạng thái DNS/máy chủ.")

    print("\n4. SITEMAP TRÊN WEBSITE (ĐO TỪ MÁY NÀY)")
    if measured:
        valid = measured.get("ok", False)
        print("   HTTP / XML        : " + ("HTTP 200 / XML hợp lệ" if valid else
                                             "CÓ LỖI: " + str(measured.get("issue") or "Chưa rõ")))
        count = measured.get("items")
        print("   Số mục trong XML  : " + (str(count) if count is not None else "Chưa đếm được"))
        duration = measured.get("seconds")
        print("   Thời gian tải     : " + ("%.2f giây" % duration if duration is not None else "Chưa đo được"))
        if valid and duration is not None and duration >= SLOW_SECONDS:
            print("   => CHẬM: vượt ngưỡng theo dõi 5 giây.")
        elif valid:
            print("   => Website trả sitemap hợp lệ; không chứng minh Google đã đọc.")
    else:
        print("   [CHƯA RÕ] Không có kết quả kiểm tra HTTP/XML.")

    print("\n5. GOOGLE SEARCH CONSOLE API (CHỈ ĐỌC)")
    if api.get("skipped"):
        print("   [BỎ QUA] Chưa cấu hình OAuth/token cho GSC API.")
    elif api_data:
        print("   Lần Google tải    : " + _display_time(api_data.get("lastDownloaded")))
        print("   Lần gửi sitemap   : " + _display_time(api_data.get("lastSubmitted")))
        pending = api_data.get("isPending")
        print("   Đang chờ xử lý    : " + ("CÓ" if pending is True else "KHÔNG" if pending is False else "Chưa rõ"))
        print("   Lỗi / cảnh báo    : %s / %s" % (
            api_data.get("errors") if api_data.get("errors") is not None else "?",
            api_data.get("warnings") if api_data.get("warnings") is not None else "?"))
        if pending is True:
            print("   => Google vẫn báo sitemap đang chờ xử lý.")
    else:
        print("   [CHƯA RÕ] API không trả dữ liệu. Thử gsc-monitor.bat --api.")

    print("\n6. GOOGLE URL INSPECTION - TRANG CHỦ")
    if inspection.get("skipped"):
        print("   [BỎ QUA] Chưa có OAuth/token read-only cho URL Inspection.")
    elif inspected:
        print("   URL                 : " + SITE)
        print("   Last crawl (index)  : " + _display_time(inspected.get("lastCrawlTime")))
        print("   Tuổi dữ liệu        : " + (str(inspection["ageDays"]) + " ngày" if inspection.get("ageDays") is not None else "Chưa rõ"))
        print("   Tình trạng index    : " + (inspected.get("verdict") or "Chưa rõ"))
        print("   Mốc sửa SEO         : 06/11/2026 10:53 (JST)")
        status = inspection.get("status")
        if status == "BEFORE_SEO":
            print("   [CẢNH BÁO] Google chưa crawl lại sau bản sửa tên Mita Japan.")
        elif status == "STALE":
            print("   [CẢNH BÁO] Google chưa crawl trang chủ trong %d ngày." % inspection["maxAgeDays"])
        elif status == "RECENT":
            if inspected.get("verdict") == "PASS":
                print("   [OK] Google đã crawl sau mốc sửa SEO; tên website vẫn do Google chọn.")
            else:
                print("   [CẢNH BÁO] Google đã crawl, nhưng index chưa xác nhận PASS.")
        else:
            print("   [CHƯA RÕ] Google chưa cung cấp ngày crawl để đối chiếu.")
        if inspected.get("crawlChanged"):
            print("   [MỚI] Last crawl đã thay đổi so với lần kiểm tra trước.")
        for alert in inspection.get("alerts", []):
            if status not in ("BEFORE_SEO", "STALE") or not alert.startswith("Google chưa crawl"):
                print("   [CẢNH BÁO] " + alert)
        print("   => Live URL Test không đồng nghĩa Google đã cập nhật bản index.")
    else:
        print("   [CHƯA RÕ] URL Inspection API không trả dữ liệu: " + inspection.get("issue", "không rõ"))

    print("\n" + "-" * 68)
    print("VIỆC NÊN LÀM:")
    suggestions = []
    if not sitemap and not crawl and not host:
        suggestions.append("Kiểm tra BrowserOS Neo đang chạy và tài khoản có quyền GSC.")
    elif not all((sitemap, crawl, host)):
        suggestions.append("Một vài báo cáo GSC chưa đọc được; hãy chạy lại sau ít phút.")
    if sitemap and sitemap.get("status") != "Success":
        suggestions.append("Theo dõi lỗi Google 'Couldn't fetch'; HTTP 200 không có nghĩa GSC đã thành công.")
    if measured and measured.get("ok") and measured.get("seconds", 0) >= SLOW_SECONDS:
        suggestions.append("Đo lại tốc độ sitemap; nếu liên tục chậm, kiểm tra backend/VPS.")
    if measured and not measured.get("ok"):
        suggestions.append("Kiểm tra lỗi HTTP/XML của sitemap trên website.")
    if not api.get("skipped") and not api_data:
        suggestions.append("Kiểm tra lại quyền OAuth hoặc kết nối GSC API.")
    if inspection.get("status") in ("BEFORE_SEO", "STALE"):
        suggestions.append("Google chưa cập nhật bản crawl trang chủ; theo dõi URL Inspection và tên website trên Google Search.")
    elif not inspection.get("skipped") and not inspected:
        suggestions.append("Kiểm tra URL Inspection API (quyền OAuth hoặc Google Cloud API).")
    if PERSIST_FAILURES:
        suggestions.append("Kiểm tra quyền ghi thư mục nhật ký .agents/runtime/gsc-monitor.")
    if not suggestions:
        suggestions.append("Chưa phát hiện vấn đề cần xử lý qua các dữ liệu đã kiểm tra.")
    for suggestion in suggestions:
        print(textwrap.fill(suggestion, width=67,
                            initial_indent="  - ", subsequent_indent="    "))
    print("\nNhật ký: .agents/runtime/gsc-monitor/history.jsonl")
    print(bar, flush=True)


def run_all(max_crawl_age_days: int = DEFAULT_MAX_CRAWL_AGE_DAYS) -> int:
    """Full, no-input one-shot check. 0=healthy, 2=observed warning, 1=incomplete."""
    PERSIST_FAILURES.clear()
    print("\nMITA JAPAN | ĐANG KIỂM TRA GSC VÀ SITEMAP...", flush=True)
    browser_info, http_info, api_info, inspection_info = {}, {}, {}, {}
    browser_ok, browser_warn = check_browser(quiet=True, report_out=browser_info)
    print("[4/6] Đang kiểm tra tốc độ và XML sitemap...", flush=True)
    http_ok = check_http(quiet=True, report_out=http_info)
    print("[5/6] Đang đọc GSC Sitemaps API (chỉ đọc)...", flush=True)
    if has_api_auth():
        api_ok, api_warn = check_api(quiet=True, with_alerts=True, report_out=api_info)
        print("[6/6] Đang đọc URL Inspection của trang chủ (chỉ đọc)...", flush=True)
        inspection_ok, inspection_warn = check_inspection(
            quiet=True, report_out=inspection_info, max_age_days=max_crawl_age_days)
    else:
        api_ok = True  # Optional; do not start OAuth or request credentials.
        api_warn = False
        api_info["skipped"] = True
        inspection_ok, inspection_warn = False, False  # Cannot verify homepage crawl without API.
        inspection_info["skipped"] = True
        print("[6/6] Bỏ qua URL Inspection (chưa có OAuth/token).", flush=True)
    outcome = 1 if not browser_ok or not api_ok or not inspection_ok else (2 if browser_warn or api_warn or inspection_warn or not http_ok else 0)
    # Latency warnings also affect the one-shot exit status.
    latest = http_info.get("result") or {}
    if outcome == 0 and latest.get("seconds") is not None and latest["seconds"] >= SLOW_SECONDS:
        outcome = 2
    if PERSIST_FAILURES:
        outcome = 1
    print_summary(browser_info, http_info, api_info, outcome, inspection_info)
    return outcome


def watch(minutes: int, max_crawl_age_days: int = DEFAULT_MAX_CRAWL_AGE_DAYS) -> None:
    if minutes < 5 or minutes > 1440:
        raise ValueError("Chu ky phai tu 5 den 1440 phut")
    print("Giam sat FOREGROUND, moi %d phut. Nhan Ctrl+C de dung." % minutes)
    while True:
        run_all(max_crawl_age_days=max_crawl_age_days)
        time.sleep(minutes * 60)


def menu() -> None:
    while True:
        print("\n==== MITA JAPAN - GSC & SITEMAP MONITOR (READ ONLY) ====")
        print("1. Mo GSC -> Sitemaps (Status / Last read / Discovered pages)")
        print("2. Mo GSC -> Settings -> Crawl stats (DNS / server / Googlebot)")
        print("3. Kiem tra URL sitemap HTTP, XML, toc do + luu lich su")
        print("4. Doc GSC Sitemaps API, so sanh va canh bao thay doi")
        print("5. Ket noi Google OAuth (read-only, can OAuth Desktop JSON)")
        print("6. Theo doi lien tuc moi 30 phut (chi trong khi cua so dang mo)")
        print("0. Thoat")
        choice = input("Chon so: ").strip()
        if choice == "0":
            return
        try:
            if choice == "1":
                open_report(GSC_SITEMAPS, "GSC Sitemaps")
            elif choice == "2":
                open_report(GSC_SETTINGS, "GSC Settings (sau do chon Crawl stats)")
            elif choice == "3":
                check_http()
            elif choice == "4":
                check_api()
            elif choice == "5":
                authorize_desktop()
            elif choice == "6":
                watch(30)
            else:
                print("Lua chon khong hop le")
        except KeyboardInterrupt:
            print("\nDa dung theo doi; tro ve menu.")
        except (OSError, ValueError, RuntimeError, urllib.error.URLError) as exc:
            print("Khong thuc hien duoc:", type(exc).__name__, str(exc) if isinstance(exc, RuntimeError) else "")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Mita GSC monitor: no website modifications")
    group = parser.add_mutually_exclusive_group()
    for name in ("all", "http", "api", "inspect", "both", "login", "watch", "menu", "open-sitemaps", "open-crawl"):
        group.add_argument("--" + name, action="store_true")
    parser.add_argument("--interval-minutes", type=int, default=30)
    parser.add_argument("--max-crawl-age-days", type=int, default=DEFAULT_MAX_CRAWL_AGE_DAYS,
                        help="Cảnh báo khi quá N ngày chưa crawl trang chủ (mặc định: 7)")
    args = parser.parse_args(argv)
    if args.max_crawl_age_days < 1:
        parser.error("--max-crawl-age-days phải >= 1")
    try:
        if args.all:
            return run_all(max_crawl_age_days=args.max_crawl_age_days)
        if args.http:
            return 0 if check_http() else 1
        if args.api:
            api_ok, api_warn = check_api(with_alerts=True)
            inspection_ok, inspection_warn = check_inspection(max_age_days=args.max_crawl_age_days)
            return 1 if not api_ok or not inspection_ok else 2 if api_warn or inspection_warn else 0
        if args.inspect:
            ok, warn = check_inspection(max_age_days=args.max_crawl_age_days)
            return 1 if not ok else 2 if warn else 0
        if args.both:
            ok = check_http()
            api_ok, api_warn = check_api(with_alerts=True)
            inspection_ok, inspection_warn = check_inspection(max_age_days=args.max_crawl_age_days)
            return 1 if not ok or not api_ok or not inspection_ok else 2 if api_warn or inspection_warn else 0
        if args.login:
            return 0 if authorize_desktop() else 1
        elif args.watch:
            watch(args.interval_minutes, max_crawl_age_days=args.max_crawl_age_days)
        elif args.open_sitemaps:
            open_report(GSC_SITEMAPS, "GSC Sitemaps")
        elif args.open_crawl:
            open_report(GSC_SETTINGS, "GSC Settings -> Crawl stats")
        elif args.menu:
            menu()
        else:
            return run_all(max_crawl_age_days=args.max_crawl_age_days)
    except KeyboardInterrupt:
        print("\nDa dung.")
        return 130
    except (RuntimeError, ValueError, OSError, urllib.error.URLError) as exc:
        print("Khong thuc hien duoc:", type(exc).__name__, str(exc) if isinstance(exc, RuntimeError) else "")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
