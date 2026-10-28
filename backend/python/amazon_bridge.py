"""Bounded sequential JSONL bridge. No DB access, browser, or child-ASIN fetching."""
import json
import re
import sys
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from amazon_parser import canonical, identity, listing, detail, ASIN

MAX_LINE = 2 * 1024 * 1024
MAX_BODY = 8 * 1024 * 1024

class SourceFailure(Exception):
    def __init__(self, state, message):
        super().__init__(message)
        self.state = state

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
        for attempt in range(3):
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
                    retry_after = str(getattr(response, 'headers', {}).get('retry-after', '0'))
                    try:
                        wait = float(retry_after)
                    except ValueError:
                        try:
                            wait = (parsedate_to_datetime(retry_after) - datetime.now(timezone.utc)).total_seconds()
                        except (ValueError, TypeError, OverflowError):
                            wait = 0
                    # Do not retry earlier than a long Retry-After or hang the IPC.
                    if attempt == 2 or wait > 10:
                        self.blocked = 'rate_limited'
                        raise SourceFailure('rate_limited', 'Amazon HTTP 429 retry budget or Retry-After requires source cooldown')
                    self.delay(max(self.pace, wait))
                    continue
                if status == 408 or status >= 500:
                    raise SourceFailure('temporary', f'Amazon HTTP {status}')
                if not 200 <= status < 300:
                    raise SourceFailure('parse_error', f'Amazon HTTP {status}; redirects are not followed')
                return html, status, str(response.url)
            except SourceFailure as exc:
                if exc.state != 'temporary':
                    raise
                if attempt == 2:
                    if rate_limited:
                        self.blocked = 'rate_limited'
                        raise SourceFailure('rate_limited', 'Amazon HTTP 429 retry budget exhausted after transient failures; source cooldown required') from None
                    raise
            except ValueError as exc:
                raise SourceFailure('parse_error', str(exc))
            except Exception:
                if attempt == 2:
                    if rate_limited:
                        self.blocked = 'rate_limited'
                        raise SourceFailure('rate_limited', 'Amazon HTTP 429 retry budget exhausted after network failures; source cooldown required') from None
                    raise SourceFailure('temporary', 'Scrapling network/timeout failure')
            finally:
                self.finished = time.monotonic()
            self.delay(0.5 * 2 ** attempt)

    def request(self, request):
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
                    self.cache[asin] = {'error': (getattr(exc, 'state', 'parse_error'), str(exc)[:500])}
            if 'error' in self.cache[asin]:
                state, message = self.cache[asin]['error']
                raise SourceFailure(state, message)
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
                outcome = dict(id=request.get('id'), ok=False, state=getattr(exc, 'state', 'parse_error'), message=str(exc)[:500])
            encoded = json.dumps(outcome, ensure_ascii=False)
            if len(encoded.encode('utf-8')) > MAX_LINE:
                encoded = json.dumps(dict(id=request.get('id'), ok=False, state='parse_error', message='Scrapling result exceeds IPC limit'))
            print(encoded, flush=True)

if __name__ == '__main__':
    main()
