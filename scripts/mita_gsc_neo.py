"""Read-only BrowserOS Neo adapter for the Mita GSC monitoring launcher.

Uses MCP over localhost with curl's -o file output to preserve UTF-8 and the
session header. No browser credentials, page HTML or screenshots are logged.
Only tabs/new, navigate and tabs/close are used; no Google write actions.
"""

from __future__ import annotations

import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import parse_qs, urlsplit


ENDPOINT = "http://127.0.0.1:9010/mcp"
SITEMAP_PATH = "/sitemap.xml"
PROPERTY = "https://mitajapanshop.duckdns.org/"
RESOURCE_ID = "resource_id=https%3A%2F%2Fmitajapanshop.duckdns.org%2F"
SITEMAPS_URL = f"https://search.google.com/search-console/sitemaps?{RESOURCE_ID}"
CRAWL_URL = f"https://search.google.com/search-console/settings/crawl-stats?{RESOURCE_ID}"
HOST_URL = f"https://search.google.com/search-console/settings/crawl-stats/host-status?{RESOURCE_ID}"


class NeoError(RuntimeError):
    pass


class NeoClient:
    """Single-run MCP session; request/response files are temporary and private."""

    def __init__(self):
        self.session = None
        self.counter = 0
        self._temp = tempfile.TemporaryDirectory(prefix="mita-neo-")
        self.path = Path(self._temp.name)
        self.curl = shutil.which("curl.exe") or shutil.which("curl")
        if not self.curl:
            self.close()
            raise NeoError("Khong tim thay curl.exe")

    def close(self):
        self._temp.cleanup()

    def _send(self, method: str, params=None, *, notification=False, timeout=45):
        self.counter += 1
        payload = {"jsonrpc": "2.0", "method": method}
        if not notification:
            payload["id"] = self.counter
        if params is not None:
            payload["params"] = params
        req_file = self.path / "request.json"
        head_file = self.path / "headers.txt"
        out_file = self.path / "response.txt"
        req_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        argv = [self.curl, "-sS", "--noproxy", "*", "--max-redirs", "0",
                "--connect-timeout", "3", "--max-time", str(timeout),
                "-D", str(head_file), "-o", str(out_file),
                "-H", "Content-Type: application/json",
                "-H", "Accept: application/json, text/event-stream"]
        if self.session:
            argv += ["-H", "mcp-session-id: " + self.session]
        argv += ["--data-binary", "@" + str(req_file), ENDPOINT]
        try:
            result = subprocess.run(argv, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                    timeout=timeout + 3, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise NeoError("BrowserOS Neo khong phan hoi (curl/timeout)") from exc
        if result.returncode not in (0, 28):  # curl 28 can still contain a complete SSE event
            raise NeoError("BrowserOS Neo khong ket noi/qua thoi gian")
        try:
            headers = head_file.read_text(encoding="utf-8")
            raw = out_file.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise NeoError("BrowserOS Neo tra response khong hop le") from exc
        status_lines = re.findall(r"(?mi)^HTTP/\S+\s+(\d{3})\b", headers)
        if not status_lines or status_lines[-1] not in ("200", "202"):
            raise NeoError("BrowserOS Neo HTTP " + (status_lines[-1] if status_lines else "unknown"))
        session = re.search(r"(?mi)^mcp-session-id:\s*([^\s]+)", headers)
        if session:
            self.session = session.group(1)
        if notification:
            return {}
        responses = []
        # MCP Streamable HTTP may return a single application/json response,
        # or SSE events (including multiline data, optional space after colon).
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                responses.append(obj)
        except ValueError:
            data_parts = []
            for line in (raw.replace("\r\n", "\n") + "\n\n").split("\n"):
                if line == "":
                    if data_parts:
                        try:
                            obj = json.loads("\n".join(data_parts))
                            if isinstance(obj, dict):
                                responses.append(obj)
                        except ValueError:
                            pass
                    data_parts = []
                elif line.startswith("data:"):
                    data_parts.append(line[5:].lstrip(" "))
        responses = [entry for entry in responses
                     if entry.get("jsonrpc") == "2.0" and entry.get("id") == self.counter]
        if not responses:
            raise NeoError("BrowserOS Neo khong tra JSON-RPC hop le")
        response = responses[-1]
        if "error" in response:
            raise NeoError("BrowserOS Neo JSON-RPC error")
        return response.get("result") or {}

    def start(self):
        response = self._send("initialize", {"protocolVersion": "2025-03-26",
                  "capabilities": {}, "clientInfo": {"name": "mita-gsc-monitor", "version": "1.0"}})
        if not self.session or response.get("serverInfo", {}).get("name") != "browseros-neo":
            raise NeoError("Khong bat tay duoc MCP BrowserOS Neo")
        self._send("notifications/initialized", notification=True, timeout=8)

    def tool(self, name: str, arguments: dict, timeout=45) -> str:
        result = self._send("tools/call", {"name": name, "arguments": arguments}, timeout=timeout)
        if result.get("isError"):
            raise NeoError("BrowserOS Neo " + name + " bao loi")
        chunks = [c.get("text", "") for c in result.get("content", []) if c.get("type") == "text"]
        if not chunks:
            raise NeoError("BrowserOS Neo " + name + " khong tra noi dung")
        return "\n".join(chunks)


def _page_content(snapshot: str, route: str, heading: str) -> str:
    """Validate observed page/route to avoid treating a login/other site as GSC."""
    marker = re.search(r"\[UNTRUSTED_PAGE_CONTENT\b[^\]]*origin=([^\s\]]+)", snapshot)
    if not marker:
        raise NeoError("BrowserOS Neo khong cung cap origin GSC")
    actual = urlsplit(marker.group(1))
    expected = urlsplit(route)
    if (actual.scheme != "https" or actual.netloc != expected.netloc
            or actual.path != expected.path
            or parse_qs(actual.query).get("resource_id") != [PROPERTY]):
        raise NeoError("BrowserOS Neo khong xac nhan duoc URL trang GSC")
    if not re.search(r"(?m)^\s+- heading \"" + re.escape(heading) + r"\" \[level=1\]", snapshot):
        raise NeoError("GSC chua hien thi bao cao " + heading + " (login/loading/quyen?)")
    return snapshot


def _table_rows(snapshot: str) -> list[list[str]]:
    rows = []
    cells = None
    for line in snapshot.splitlines():
        if re.match(r"^\s+- row(?:\s|$)", line) and "rowgroup" not in line:
            if cells is not None:
                rows.append(cells)
            cells = []
        elif cells is not None:
            match = re.match(r'^\s+- cell(?:\s+"([^"]*)")?(?:\s|$)', line)
            if match:
                cells.append(match.group(1) or "")
    if cells is not None:
        rows.append(cells)
    return rows


def parse_sitemaps(snapshot: str) -> dict:
    _page_content(snapshot, "https://search.google.com/search-console/sitemaps", "Sitemaps")
    matches = [row for row in _table_rows(snapshot)
               if len(row) >= 6 and row[0].strip().rstrip("/") == SITEMAP_PATH]
    if len(matches) != 1:
        raise NeoError("Sitemaps: khong co dung mot dong /sitemap.xml")
    row = matches[0]
    raw_pages = row[5].strip().replace(",", "")
    if not row[4].strip() or not raw_pages.isdigit():
        raise NeoError("Sitemaps: thieu Status hoac Discovered pages")
    return {"status": row[4].strip(), "lastRead": row[3].strip() or None,
            "discoveredPages": int(raw_pages),
            "submitted": row[2].strip() or None, "type": row[1].strip() or None}


def parse_crawl(snapshot: str) -> dict:
    _page_content(snapshot, "https://search.google.com/search-console/settings/crawl-stats", "Crawl stats")
    count = re.search(r'- button "Total crawl requests\s+([\d,]+)"', snapshot)
    average = re.search(r'- button "Average response time \(ms\)\s+([\d,]+)"', snapshot)
    if not count or not average:
        raise NeoError("Crawl stats: khong thay tong crawl/thoi gian Googlebot")
    response_types = {}
    for row in _table_rows(snapshot):
        if len(row) >= 2 and re.search(r"\(\d{3}\)", row[0]) and re.match(r"^[\d.]+%$", row[1]):
            response_types[row[0]] = row[1]
    if not response_types:
        raise NeoError("Crawl stats: thieu cac nhom HTTP trong bang")
    return {"totalCrawls": int(count.group(1).replace(",", "")),
            "averageResponseMs": int(average.group(1).replace(",", "")),
            "responseCodesShown": response_types}


def parse_host(snapshot: str) -> dict:
    _page_content(snapshot, "https://search.google.com/search-console/settings/crawl-stats/host-status", "Host status")
    values = {}
    for key, text in (("robotsTxt", "robots.txt fetch"),
                      ("dns", "DNS resolution"), ("server", "Server connectivity")):
        found = re.search(r'- button "' + re.escape(text) + r'\s+(.*?)"', snapshot)
        values[key] = (found.group(1).strip().removeprefix("null ") if found else None)
    if not all(values.values()):
        raise NeoError("Host status: thieu trang thai robots.txt/DNS/server")
    return values


def collect(progress=None) -> dict:
    """One automatic read-only BrowserOS session; own exactly one temporary tab."""
    result = {"sitemaps": None, "crawlStats": None, "hostStatus": None, "errors": {}}
    client = NeoClient()
    page = None
    try:
        client.start()
        opened = client.tool("tabs", {"action": "new", "url": SITEMAPS_URL})
        found = re.search(r"opened page (\d+)", opened)
        if not found:
            raise NeoError("BrowserOS Neo khong mo duoc tab GSC")
        page = int(found.group(1))
        for section, url, parser in (("sitemaps", SITEMAPS_URL, parse_sitemaps),
                                     ("crawlStats", CRAWL_URL, parse_crawl),
                                     ("hostStatus", HOST_URL, parse_host)):
            try:
                if progress is not None:
                    progress(section)
                snapshot = client.tool("navigate", {"action": "url", "page": page, "url": url})
                result[section] = parser(snapshot)
            except (NeoError, ValueError, TypeError) as exc:
                result["errors"][section] = str(exc)[:160]
    finally:
        if page is not None:
            try:
                client.tool("tabs", {"action": "close", "page": page}, timeout=12)
            except NeoError:
                pass
        client.close()
    return result
