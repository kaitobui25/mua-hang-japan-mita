import unittest
from pathlib import Path
from types import SimpleNamespace
from datetime import datetime, timezone, timedelta
from email.utils import format_datetime
from amazon_parser import detail, listing, identity
from amazon_bridge import Client, SourceFailure

ASIN = 'B000000001'
CATEGORY = 'thuc-pham-bo-sung'
OBSERVED = '2026-10-28T00:00:00+00:00'
HTML = (Path(__file__).parent.parent / 'tests/fixtures/amazon-detail.html').read_text(encoding='utf-8')

class Session:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = []
    def get(self, url, **kwargs):
        self.calls.append((url, kwargs))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return SimpleNamespace(status=response[0], body=response[1].encode(), url=response[2] if len(response) > 2 else url, encoding='utf-8', headers=response[3] if len(response) > 3 else {})

class Tests(unittest.TestCase):
    def test_detail_gallery_fields_and_variants(self):
        item = detail(HTML, ASIN, CATEGORY, OBSERVED)
        self.assertEqual(item['priceJpy'], 2980)
        self.assertEqual(len(item['imageUrls']), 6)
        self.assertTrue(item['imageUrls'][0].endswith('cover._SL1500_.jpg'))
        self.assertFalse(any('unrelated' in u or 'other-child' in u or 'evil.test' in u for u in item['imageUrls']))
        self.assertIn('gallery:complete', item['detail']['provenance']['sections'])
        self.assertEqual(item['parentAsin'], 'B000000099')
        self.assertEqual(item['detail']['childAsins'], ['B000000002'])
        self.assertEqual(item['detail']['variantAttributes']['Size'], '1 kg')
        self.assertEqual(item['detail']['ingredients'], ['乳清たんぱく、バニラ香料'])
        self.assertEqual(item['detail']['usage'], ['水200mlに溶かす'])
        self.assertEqual(item['detail']['cautions'], ['乳成分を含む'])

    def test_identity(self):
        for html in [HTML.replace('value="B000000001"', 'value="B000000002"'), HTML.replace('https://www.amazon.co.jp/dp/B000000001', 'https://evil.test/dp/B000000001'), HTML.replace('href="https://www.amazon.co.jp/dp/B000000001"', 'href="https://www.amazon.co.jp/dp/B000000002"')]:
            with self.assertRaises(ValueError):
                detail(html, ASIN, CATEGORY, OBSERVED)
        with self.assertRaises(ValueError):
            identity('https://www.amazon.co.jp.evil.test/dp/' + ASIN)

    def test_both_listings(self):
        html = f'<div data-component-type="s-search-result" data-asin="{ASIN}"><h2>Japanese fixture product</h2><img alt="Japanese fixture product" src="https://m.media-amazon.com/a.jpg"><span class="a-price"><span class="a-offscreen">￥1,200</span></span></div>'
        for category in [CATEGORY, 'thuc-pham-cho-be']:
            self.assertEqual(listing(html, category, OBSERVED)[0]['priceJpy'], 1200)

    def test_unrelated_scripts_do_not_lend_identity(self):
        html = HTML.replace('"parentAsin":"B000000099"', '"parentAsin":"B999999999"').replace('"B000000001":{"size_name":"0","flavor_name":"0"},', '')
        item = detail(html, ASIN, CATEGORY, OBSERVED)
        self.assertIsNone(item['parentAsin'])
        self.assertEqual(item['detail']['childAsins'], ['B000000002']) # real DOM evidence remains
        malicious = '<script>{"currentAsin":"B999999999","colorImages":{"initial":[{"hiRes":"https://m.media-amazon.com/forged.jpg"}]}}</script>'
        self.assertFalse(any('forged' in u for u in detail(HTML + malicious, ASIN, CATEGORY, OBSERVED)['imageUrls']))

    def test_cache_never_fetches_children(self):
        session = Session([(200, HTML)])
        client = Client(session, lambda _: None)
        request = dict(op='detail', asin=ASIN, category=CATEGORY)
        a = client.request(request)
        b = client.request({**request, 'category': 'thuc-pham-cho-be'})
        self.assertEqual(len(session.calls), 1)
        self.assertEqual(b['result']['categorySlug'], 'thuc-pham-cho-be')
        self.assertEqual(a['result']['observedAt'], b['result']['observedAt'])
        self.assertFalse(session.calls[0][1]['follow_redirects'])

    def test_transient_retry_bound(self):
        for responses in [[(503, '')] * 3, [TimeoutError()] * 3]:
            session = Session(responses)
            with self.assertRaises(SourceFailure) as context:
                Client(session, lambda _: None).fetch('https://www.amazon.co.jp/dp/' + ASIN)
            self.assertEqual(context.exception.state, 'temporary')
            self.assertEqual(len(session.calls), 3)

    def test_denial_and_challenges_latch(self):
        for response in [(403, ''), (200, '<input id="captchacharacters">'), (200, '<form action="/ap/signin">')]:
            session = Session([response])
            client = Client(session, lambda _: None)
            for _ in range(2):
                with self.assertRaises(SourceFailure) as context:
                    client.fetch('https://www.amazon.co.jp/dp/' + ASIN)
                self.assertEqual(context.exception.state, 'blocked')
            self.assertEqual(len(session.calls), 1)

    def test_rate_limit_two_retries_then_cooldown_latch(self):
        session = Session([(429, '')] * 3)
        waits = []
        client = Client(session, waits.append)
        for _ in range(2):
            with self.assertRaises(SourceFailure) as context:
                client.fetch('https://www.amazon.co.jp/dp/' + ASIN)
            self.assertEqual(context.exception.state, 'rate_limited')
        self.assertEqual(len(session.calls), 3)
        self.assertGreaterEqual(client.pace, 9.6)
        self.assertTrue(any(wait >= 4.8 for wait in waits))

    def test_rate_limit_then_transient_exhaustion_still_cools_down(self):
        for tail in [[TimeoutError(), TimeoutError()], [(503, ''), (503, '')]]:
            session = Session([(429, ''), *tail])
            client = Client(session, lambda _: None)
            for _ in range(2):
                with self.assertRaises(SourceFailure) as context:
                    client.fetch('https://www.amazon.co.jp/dp/' + ASIN)
                self.assertEqual(context.exception.state, 'rate_limited')
            self.assertEqual(len(session.calls), 3)

    def test_rate_limit_retry_after_and_success(self):
        session = Session([(429, '', 'https://www.amazon.co.jp/dp/' + ASIN, {'retry-after': '7'}), (200, HTML)])
        waits = []
        client = Client(session, waits.append)
        self.assertIn('productTitle', client.fetch('https://www.amazon.co.jp/dp/' + ASIN)[0])
        self.assertEqual(len(session.calls), 2)
        self.assertIn(7, waits)
        self.assertGreaterEqual(client.pace, 2.4)

    def test_long_retry_after_stops_without_early_retry_or_hang(self):
        session = Session([(429, '', 'https://www.amazon.co.jp/dp/' + ASIN, {'retry-after': '3600'})])
        waits = []
        client = Client(session, waits.append)
        with self.assertRaises(SourceFailure) as context:
            client.fetch('https://www.amazon.co.jp/dp/' + ASIN)
        self.assertEqual(context.exception.state, 'rate_limited')
        self.assertEqual(len(session.calls), 1)
        self.assertEqual(waits, [])

    def test_retry_after_http_date_and_invalid_header_are_bounded(self):
        for header in [format_datetime(datetime.now(timezone.utc) + timedelta(seconds=8), usegmt=True), 'invalid']:
            session = Session([(429, '', 'https://www.amazon.co.jp/dp/' + ASIN, {'retry-after': header}), (200, HTML)])
            waits = []
            Client(session, waits.append).fetch('https://www.amazon.co.jp/dp/' + ASIN)
            self.assertEqual(len(session.calls), 2)
            self.assertTrue(all(0 <= wait <= 10 for wait in waits))
            if header != 'invalid':
                self.assertGreater(waits[0], 5)

    def test_login_redirect_latches_without_following(self):
        session = Session([(302, '', 'https://www.amazon.co.jp/dp/' + ASIN, {'location': '/ap/signin'})])
        client = Client(session, lambda _: None)
        for _ in range(2):
            with self.assertRaises(SourceFailure) as context:
                client.fetch('https://www.amazon.co.jp/dp/' + ASIN)
            self.assertEqual(context.exception.state, 'blocked')
        self.assertEqual(len(session.calls), 1)

    def test_challenge_on_429_stops_without_rate_limit_retry(self):
        session = Session([(429, '<input id="captchacharacters">')])
        client = Client(session, lambda _: None)
        with self.assertRaises(SourceFailure) as context:
            client.fetch('https://www.amazon.co.jp/dp/' + ASIN)
        self.assertEqual(context.exception.state, 'blocked')
        self.assertEqual(len(session.calls), 1)

    def test_rate_limit_followed_by_challenge_stops_immediately(self):
        session = Session([(429, ''), (200, '<input id="captchacharacters">')])
        client = Client(session, lambda _: None)
        for _ in range(2):
            with self.assertRaises(SourceFailure) as context:
                client.fetch('https://www.amazon.co.jp/dp/' + ASIN)
            self.assertEqual(context.exception.state, 'blocked')
        self.assertEqual(len(session.calls), 2)

    def test_normal_signin_link_is_not_login_page(self):
        session = Session([(200, HTML + '<a href="/ap/signin">Account</a>')])
        self.assertIn('productTitle', Client(session, lambda _: None).fetch('https://www.amazon.co.jp/dp/' + ASIN)[0])

    def test_conflicting_variant_current_asin_is_rejected(self):
        script = '<script>{"currentAsin":"B999999999","parentAsin":"B999999998","asinVariationValues":{"B000000001":{"size_name":"XL"},"B000000003":{}}}</script>'
        item = detail(HTML + script, ASIN, CATEGORY, OBSERVED)
        self.assertEqual(item['parentAsin'], 'B000000099')
        self.assertNotIn('B000000003', item['detail']['childAsins'])

    def test_initial_is_bounded_to_color_images(self):
        minimal = '<input id="ASIN" value="B000000001"><span id="productTitle">Fixture product name</span><img id="landingImage" src="https://m.media-amazon.com/front.jpg">'
        script = '<script>{"currentAsin":"B000000001","colorImages":{"blue":[]},"recommendations":{"initial":[{"hiRes":"https://m.media-amazon.com/forged.jpg"}]}}</script>'
        item = detail(minimal + script, ASIN, CATEGORY, OBSERVED)
        self.assertEqual(item['imageUrls'], ['https://m.media-amazon.com/front.jpg'])
        self.assertNotIn('gallery:complete', item['detail']['provenance']['sections'])

    def test_failed_asin_is_not_downloaded_again(self):
        session = Session([(200, 'invalid product')])
        client = Client(session, lambda _: None)
        for category in [CATEGORY, 'thuc-pham-cho-be']:
            with self.assertRaises(SourceFailure):
                client.request(dict(op='detail', asin=ASIN, category=category))
        self.assertEqual(len(session.calls), 1)

    def test_installed_fetcher_session_redirect_api_without_amazon(self):
        try:
            from scrapling.fetchers import FetcherSession
        except ImportError:
            self.skipTest('Scrapling not installed in this interpreter')
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append(self.path)
                self.send_response(302)
                self.send_header('Location', '/must-not-follow')
                self.end_headers()
            def log_message(self, *args):
                pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with FetcherSession(retries=0, follow_redirects=False) as session:
                response = session.get(f'http://127.0.0.1:{server.server_port}/redirect', follow_redirects=False, timeout=5)
                self.assertEqual(response.status, 302)
                self.assertEqual(calls, ['/redirect'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_real_dom_options_exclude_recommended_variations(self):
        html = HTML + '<div id="variation_size_name"><select><option value="B000000005">Large</option></select><li data-dp-url="/dp/B000000006">Small</li></div><div id="recommendations"><div id="variation_style_name"><li data-asin="B999999999"></li></div></div>'
        item = detail(html, ASIN, CATEGORY, OBSERVED)
        self.assertEqual(item['detail']['childAsins'], ['B000000002', 'B000000005', 'B000000006'])

    def test_redirect_never_followed(self):
        session = Session([(302, '')])
        with self.assertRaises(SourceFailure):
            Client(session, lambda _: None).fetch('https://www.amazon.co.jp/dp/' + ASIN)
        self.assertEqual(len(session.calls), 1)

if __name__ == '__main__':
    unittest.main()
