"""Bounded sequential JSONL bridge. No DB access, browser, or child-ASIN fetching."""
import json
import re
import sys
import time
import base64
import zlib
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from amazon_parser import canonical, identity, listing, detail, ASIN

MAX_LINE = 2 * 1024 * 1024
MAX_BODY = 8 * 1024 * 1024
MAX_QUOTE_BODY = 3_000_000
MAX_QUOTE_COMPRESSED = 1_500_000

class SourceFailure(Exception):
    def __init__(self, state, message, retry_after_at=None, quote_code=None):
        super().__init__(message)
        self.state = state
        self.retry_after_at = retry_after_at
        self.quote_code = quote_code

class Client:
    def __init__(self, session, delay=time.sleep):
        self.session = session
        self.delay = delay
        self.finished = None
        self.blocked = None
        self.pace = 1.2
        self.cache = {}

    def fetch(self, url):
        canonical(url)
        if self.blocked:
            raise SourceFailure(self.blocked, 'Amazon session stopped; source cooldown required')
        rate_limited = False
        # At most one retry per fetch. A 429 is only retryable when Amazon
        # explicitly provides a positive Retry-After within the IPC budget.
        for attempt in range(2):
            if self.finished is not None:
                self.delay(max(0, self.pace - (time.monotonic() - self.finished)))
            try:
                # Disable redirects so an untrusted Location is never requested.
                response = self.session.get(url, timeout=30, follow_redirects=False)
                status = response.status
                canonical(str(response.url))
                location = str(getattr(response, 'headers', {}).get('location', ''))
                if status == 403 or (300 <= status < 400 and re.search(r'/ap/(?:signin|cvf)|captcha', location, re.I)):
                    self.blocked = 'blocked'
                    raise SourceFailure('blocked', f'Amazon HTTP {status} access/login verification; source cooldown required')
                body = response.body
                if len(body) > MAX_BODY:
                    if status == 429:
                        self.blocked = 'rate_limited'
                        raise SourceFailure('rate_limited', 'Amazon HTTP 429 oversized response; source cooldown required')
                    raise SourceFailure('parse_error', 'Amazon response exceeds body limit')
                html = body.decode(response.encoding or 'utf-8', errors='replace')
                from bs4 import BeautifulSoup
                challenge = BeautifulSoup(html, 'html.parser')
                login = challenge.select_one('form[action*="/ap/signin"], form[action*="/ap/cvf"], form[action*="validateCaptcha"]')
                if status == 403 or login or re.search(r'/errors/validatecaptcha|captchacharacters|<title[^>]*>\s*(?:Amazon\s+)?Robot Check|enter the characters you see below|画像に表示されている文字を入力|verification required', html, re.I):
                    self.blocked = 'blocked'
                    raise SourceFailure('blocked', f'Amazon HTTP {status} CAPTCHA/login/access verification; source cooldown required')
                if status == 429:
                    rate_limited = True
                    self.pace = max(self.pace, 2.4 * 2 ** attempt)
                    retry_after = str(getattr(response, 'headers', {}).get('retry-after', '')).strip()
                    wait = None
                    try:
                        if retry_after:
                            wait = float(retry_after)
                    except (ValueError, OverflowError):
                        try:
                            wait = (parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)).total_seconds()
                        except (ValueError, TypeError, OverflowError):
                            wait = None
                    # Respect long source cooldowns instead of sleeping beyond
                    # the bounded IPC. Never infer permission from a missing,
                    # expired or malformed header.
                    if attempt == 1 or wait is None or not 0 < wait <= 180:
                        self.blocked = 'rate_limited'
                        source_deadline = (datetime.now(timezone.utc) + timedelta(seconds=wait)).isoformat() if wait is not None and 0 < wait < 365 * 86400 else None
                        raise SourceFailure('rate_limited', 'Amazon HTTP 429: no permitted bounded retry; source cooldown required', source_deadline)
                    self.delay(max(120, self.pace, wait))
                    continue
                if status == 408 or status >= 500:
                    raise SourceFailure('temporary', f'Amazon HTTP {status}')
                if not 200 <= status < 300:
                    raise SourceFailure('parse_error', f'Amazon HTTP {status}; redirects are not followed')
                return html, status, str(response.url)
            except SourceFailure as exc:
                if exc.state != 'temporary':
                    raise
                if attempt == 1:
                    if rate_limited:
                        self.blocked = 'rate_limited'
                        raise SourceFailure('rate_limited', 'Amazon HTTP 429 retry budget exhausted after transient failures; source cooldown required') from None
                    raise
            except ValueError as exc:
                raise SourceFailure('parse_error', str(exc))
            except Exception:
                if attempt == 1:
                    if rate_limited:
                        self.blocked = 'rate_limited'
                        raise SourceFailure('rate_limited', 'Amazon HTTP 429 retry budget exhausted after network failures; source cooldown required') from None
                    raise SourceFailure('temporary', 'Scrapling network/timeout failure')
            finally:
                self.finished = time.monotonic()
            self.delay(0.5 * 2 ** attempt)

    def quote_denial(self, status, headers):
        if status not in (403, 429):
            return
        self.blocked = 'rate_limited' if status == 429 else 'blocked'
        retry = headers.get('retry-after', '').strip()
        deadline = None
        try:
            date = (datetime.now(timezone.utc) + timedelta(seconds=int(retry))) if re.fullmatch(r'[0-9]+', retry) else parsedate_to_datetime(retry)
            if date.tzinfo is not None:
                deadline = date.astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        except (ValueError, TypeError, OverflowError):
            pass
        raise SourceFailure(self.blocked, f'Amazon HTTP {status}; source cooldown required', deadline)

    def quote(self, request):
        asin, quantity, timeout = request.get('asin'), request.get('quantity'), request.get('timeoutMs')
        if not isinstance(asin, str) or not ASIN.fullmatch(asin):
            raise ValueError('Invalid ASIN')
        if type(quantity) is not int or not 1 <= quantity <= 99:
            raise ValueError('Invalid quantity')
        if type(timeout) is not int or not 1 <= timeout <= 120_000:
            raise ValueError('Invalid quote timeout')
        url = f'https://www.amazon.co.jp/dp/{asin}?quantity={quantity}'
        if request.get('url') != url:
            raise ValueError('Invalid quote URL')
        if self.blocked:
            raise SourceFailure(self.blocked, 'Amazon session stopped; source cooldown required')
        observed = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        body = bytearray()
        oversized = False

        def receive(chunk):
            nonlocal oversized
            if len(body) + len(chunk) > MAX_QUOTE_BODY:
                oversized = True
                return 0  # Abort curl before retaining an unbounded response.
            body.extend(chunk)
            return len(chunk)

        try:
            # Quotes never use ingestion retries, browser impersonation, generated
            # stealth headers, redirects, cached snapshots or alternate ASINs.
            response = self.session.get(url, timeout=timeout / 1000, retries=0,
                                        follow_redirects=False, impersonate=None,
                                        stealthy_headers=False,
                                        headers={'Accept-Language': 'ja-JP', 'Accept': 'text/html', 'User-Agent': 'MitaJapan/1.0'},
                                        content_callback=receive)
        except Exception as exc:
            # curl includes received status/headers on callback aborts and read
            # failures. An access denial must still reach the shared cooldown.
            partial = getattr(exc, 'response', None)
            if partial is not None:
                self.quote_denial(getattr(partial, 'status_code', None),
                                  {str(k).lower(): str(v) for k, v in partial.headers.items()})
            if oversized:
                raise SourceFailure('parse_error', 'Quote body limit exceeded', quote_code='amazon_response_too_large') from None
            raise SourceFailure('temporary', 'Scrapling quote network/timeout failure') from None
        headers = {str(k).lower(): str(v) for k, v in response.headers.items()}
        status = response.status
        self.quote_denial(status, headers)
        if oversized:
            raise SourceFailure('parse_error', 'Quote body limit exceeded', quote_code='amazon_response_too_large')
        location = headers.get('location', '')
        if 300 <= status < 400 and re.search(r'/ap/(?:signin|cvf)|captcha', location, re.I):
            self.blocked = 'blocked'
            raise SourceFailure('blocked', 'Amazon login/CAPTCHA redirect; source cooldown required')
        if str(response.url) != url or not 200 <= status < 300 or headers.get('content-type', '').split(';')[0].strip().lower() != 'text/html':
            raise SourceFailure('temporary', 'Invalid quote HTTP response or URL identity')
        # The callback owns the bytes; FetcherSession's response body is empty.
        html = body.decode(response.encoding or 'utf-8', errors='replace')
        from bs4 import BeautifulSoup
        challenge = BeautifulSoup(html, 'html.parser')
        if challenge.select_one('form[action*="/ap/signin"], form[action*="/ap/cvf"]') or re.search(r'captcha|<title[^>]*>\s*(?:Amazon\s+)?Robot Check|enter the characters you see below|ロボットではない|verification required', html, re.I):
            self.blocked = 'blocked'
            raise SourceFailure('blocked', 'Amazon CAPTCHA/login verification; source cooldown required')
        encoded = html.encode('utf-8')
        if len(encoded) > MAX_QUOTE_BODY:
            raise SourceFailure('parse_error', 'Quote UTF-8 body limit exceeded', quote_code='amazon_response_too_large')
        compressed = zlib.compress(encoded)
        if len(compressed) > MAX_QUOTE_COMPRESSED:
            raise SourceFailure('parse_error', 'Quote IPC limit exceeded', quote_code='amazon_response_too_large')
        return dict(result=dict(asin=asin, quantity=quantity, url=url, observedAt=observed,
                                htmlBytes=len(encoded), htmlZlibBase64=base64.b64encode(compressed).decode('ascii')))

    def request(self, request):
        if request.get('op') == 'quote':
            return self.quote(request)
        op, category = request['op'], request['category']
        if category not in ('thuc-pham-bo-sung', 'thuc-pham-cho-be'):
            raise ValueError('Invalid category')
        observed = datetime.now(timezone.utc).isoformat()
        if op == 'detail':
            asin = request['asin']
            if not ASIN.fullmatch(asin):
                raise ValueError('Invalid ASIN')
            if asin not in self.cache:
                if len(self.cache) >= 400:
                    raise ValueError('Per-session ASIN cache limit reached')
                try:
                    html, status, url = self.fetch(f'https://www.amazon.co.jp/dp/{asin}')
                    if identity(url) != asin:
                        raise ValueError('Response URL ASIN mismatch')
                    self.cache[asin] = dict(result=detail(html, asin, category, observed), status=status, url=url)
                except Exception as exc:
                    # Do not retain traceback frames containing entire parsed pages.
                    self.cache[asin] = {'error': (getattr(exc, 'state', 'parse_error'), str(exc)[:500], getattr(exc, 'retry_after_at', None))}
            if 'error' in self.cache[asin]:
                state, message, deadline = self.cache[asin]['error']
                raise SourceFailure(state, message, deadline)
            cached = self.cache[asin]
            return {**cached, 'result': {**cached['result'], 'categorySlug': category}}
        if op == 'listing':
            url = request['url']
            p = canonical(url)
            if p.path not in ('/gp/bestsellers/hpc/3457072051', '/s'):
                raise ValueError('Invalid listing URL')
            html, status, final = self.fetch(url)
            return dict(result=listing(html, category, observed), status=status, url=final)
        raise ValueError('Invalid operation')

def main():
    # Import lazily so fixture tests never need transport dependencies.
    from scrapling.fetchers import FetcherSession
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    with FetcherSession(retries=0, follow_redirects=False) as session:
        client = Client(session)
        while True:
            line = sys.stdin.buffer.readline(MAX_LINE + 1)
            if not line:
                break
            if len(line) > MAX_LINE:
                break
            request = {}
            try:
                request = json.loads(line)
                outcome = dict(id=request['id'], ok=True, **client.request(request))
            except Exception as exc:
                outcome = dict(id=request.get('id'), ok=False, state=getattr(exc, 'state', 'parse_error'),
                               message=str(exc)[:500], retryAfterAt=getattr(exc, 'retry_after_at', None),
                               code=getattr(exc, 'quote_code', None))
            encoded = json.dumps(outcome, ensure_ascii=False)
            if len(encoded.encode('utf-8')) > MAX_LINE:
                encoded = json.dumps(dict(id=request.get('id'), ok=False, state='parse_error', message='Scrapling result exceeds IPC limit'))
            print(encoded, flush=True)

if __name__ == '__main__':
    main()
