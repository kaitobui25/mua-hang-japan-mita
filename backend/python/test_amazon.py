import unittest
import base64
import zlib
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
        body = response[1].encode()
        if 'content_callback' in kwargs:
            if kwargs['content_callback'](body) != len(body):
                failure = RuntimeError('fixture curl callback aborted')
                failure.response = SimpleNamespace(status_code=response[0], headers=response[3] if len(response) > 3 else {})
                raise failure
            body = b''
        return SimpleNamespace(status=response[0], body=body, url=response[2] if len(response) > 2 else url, encoding='utf-8', headers=response[3] if len(response) > 3 else {})

class Tests(unittest.TestCase):
    def test_inspect_presence_and_price_do_not_require_a_gallery(self):
        url=f'https://www.amazon.co.jp/dp/{ASIN}'
        html=f'<input id="ASIN" value="{ASIN}"><span id="productTitle">Real existing product name</span><div id="availability">在庫切れ</div>'
        session=Session([(200,html,url)])
        result=Client(session).request(dict(op='inspect',asin=ASIN,category=CATEGORY))['result']
        self.assertEqual(result['presence'],'present')
        self.assertEqual(result['availability'],'out_of_stock')
        self.assertIsNone(result['priceJpy'])
        self.assertEqual(len(session.calls),1)
        self.assertFalse(session.calls[0][1]['follow_redirects'])

    def test_inspect_price_ignores_reference_and_strikethrough_price(self):
        url=f'https://www.amazon.co.jp/dp/{ASIN}'
        html=(f'<input id="ASIN" value="{ASIN}"><span id="productTitle">Real existing product name</span>'
              '<div id="corePriceDisplay_desktop_feature_div">'
              '<span class="basisPrice"><span class="a-price"><span class="a-offscreen">￥9,999</span></span></span>'
              '<span class="priceToPay"><span class="a-offscreen">￥2,380</span></span></div>')
        result=Client(Session([(200,html,url)])).request(dict(op='inspect',asin=ASIN,category=CATEGORY))['result']
        self.assertEqual(result['priceJpy'],2380)
        reference_only=html.replace('class="priceToPay"','class="basisPrice"')
        missing=Client(Session([(200,reference_only,url)])).request(dict(op='inspect',asin=ASIN,category=CATEGORY))['result']
        self.assertIsNone(missing['priceJpy'])
        conflicting=html.replace('</div>',
            '<div id="priceblock_ourprice">￥3,500</div></div>')
        uncertain=Client(Session([(200,conflicting,url)])).request(dict(op='inspect',asin=ASIN,category=CATEGORY))['result']
        self.assertIsNone(uncertain['priceJpy'])

    def test_inspect_http_404_is_evidence_only_not_a_deletion(self):
        url=f'https://www.amazon.co.jp/dp/{ASIN}'
        result=Client(Session([(404,'Not found',url)])).request(
            dict(op='inspect',asin=ASIN,category=CATEGORY))['result']
        self.assertEqual(result['presence'],'not_found_http_404')
        self.assertEqual(result['availability'],'unknown')

    def test_inspect_rejects_wrong_asin_and_challenge(self):
        url=f'https://www.amazon.co.jp/dp/{ASIN}'
        wrong='<input id="ASIN" value="B000000002"><span id="productTitle">Some other product name</span>'
        with self.assertRaises(SourceFailure):
            Client(Session([(200,wrong,url)])).request(dict(op='inspect',asin=ASIN,category=CATEGORY))
        with self.assertRaises(SourceFailure) as context:
            Client(Session([(200,'<title>Amazon Robot Check</title>',url)])).request(
                dict(op='inspect',asin=ASIN,category=CATEGORY))
        self.assertEqual(context.exception.state,'blocked')

    def quote_request(self, **overrides):
        return dict(op='quote', asin=ASIN, quantity=1, timeoutMs=15000,
                    url=f'https://www.amazon.co.jp/dp/{ASIN}?quantity=1') | overrides

    def test_quote_transports_only_bounded_original_html_without_retries_or_spoofing(self):
        session = Session([(200, HTML, self.quote_request()['url'], {'content-type': 'text/html; charset=utf-8'})])
        result = Client(session).request(self.quote_request())['result']
        self.assertEqual(zlib.decompress(base64.b64decode(result['htmlZlibBase64'])).decode(), HTML)
        self.assertEqual(result['htmlBytes'], len(HTML.encode()))
        self.assertEqual(result['asin'], ASIN)
        self.assertEqual(result['url'], self.quote_request()['url'])
        observed = datetime.fromisoformat(result['observedAt'])
        self.assertLess(abs((observed - datetime.now(timezone.utc)).total_seconds()), 1)
        self.assertEqual(len(session.calls), 1)
        options = session.calls[0][1]
        self.assertFalse(options['follow_redirects'])
        self.assertEqual(options['retries'], 0)
        self.assertIsNone(options['impersonate'])
        self.assertFalse(options['stealthy_headers'])
        self.assertEqual(options['headers']['User-Agent'], 'MitaJapan/1.0')
        self.assertEqual(options['timeout'], 15)

    def test_quote_invalid_inputs_never_fetch(self):
        for override in [dict(asin='bad'), dict(asin=ASIN + '\n'), dict(asin=1), dict(quantity=True),
                         dict(quantity=0), dict(quantity=100), dict(quantity='1'), dict(timeoutMs=0),
                         dict(timeoutMs=120001), dict(timeoutMs=True), dict(url='https://evil.test/'),
                         dict(url=f'https://www.amazon.co.jp/dp/{ASIN}?quantity=2')]:
            session = Session([])
            with self.assertRaises(ValueError):
                Client(session).request(self.quote_request(**override))
            self.assertEqual(session.calls, [])

    def test_quote_installed_fetcher_callback_contract_without_network(self):
        from unittest.mock import patch
        try:
            from scrapling.fetchers import FetcherSession
        except ImportError:
            self.skipTest('Optional Scrapling transport environment not installed')

        def fixture_request(*args, **kwargs):
            self.assertIsNone(kwargs['impersonate'])
            self.assertFalse(kwargs['allow_redirects'])
            self.assertNotIn('referer', {k.lower() for k in kwargs['headers']})
            self.assertEqual(kwargs['headers']['User-Agent'], 'MitaJapan/1.0')
            body = HTML.encode()
            self.assertEqual(kwargs['content_callback'](body), len(body))
            return SimpleNamespace(url=kwargs['url'], content=b'', status_code=200, reason='OK',
                                   encoding='utf-8', cookies={}, headers={'content-type': 'text/html'},
                                   request=None, history=[])

        with patch('scrapling.engines.static.CurlSession.request', side_effect=fixture_request) as network:
            with FetcherSession(retries=0, follow_redirects=False) as session:
                result = Client(session).request(self.quote_request())['result']
            self.assertEqual(network.call_count, 1)
            self.assertEqual(zlib.decompress(base64.b64decode(result['htmlZlibBase64'])).decode(), HTML)

    def test_quote_denials_preserve_deadlines_and_latch_without_retry(self):
        for status in (403, 429):
            for retry in ('60', '604800', format_datetime(datetime.now(timezone.utc) + timedelta(days=2), usegmt=True), 'invalid', '9' * 500):
                session = Session([(status, 'captcha', self.quote_request()['url'], {'retry-after': retry})])
                client = Client(session)
                with self.assertRaises(SourceFailure) as caught:
                    client.request(self.quote_request())
                self.assertEqual(caught.exception.state, 'blocked' if status == 403 else 'rate_limited')
                self.assertEqual(bool(caught.exception.retry_after_at), retry not in ('invalid', '9' * 500))
                with self.assertRaises(SourceFailure):
                    client.request(self.quote_request())
                self.assertEqual(len(session.calls), 1)

    def test_quote_rejects_challenges_redirects_wrong_identity_and_non_html(self):
        url = self.quote_request()['url']
        for status, body, final, headers, state in [
            (200, '<input id="captchacharacters">', url, {'content-type': 'text/html'}, 'blocked'),
            (200, '<form action="/ap/signin">', url, {'content-type': 'text/html'}, 'blocked'),
            (200, '<title>Amazon Robot Check</title>', url, {'content-type': 'text/html'}, 'blocked'),
            (302, '', url, {'location': '/ap/cvf'}, 'blocked'),
            (302, '', url, {'location': '/dp/B000000002'}, 'temporary'),
            (503, '', url, {}, 'temporary'),
            (200, HTML, url, {'content-type': 'application/json'}, 'temporary'),
            (200, HTML, 'https://evil.test/dp/' + ASIN, {'content-type': 'text/html'}, 'temporary'),
            (200, HTML, url.replace(ASIN, 'B000000002'), {'content-type': 'text/html'}, 'temporary'),
            (200, HTML, url.replace('quantity=1', 'quantity=2'), {'content-type': 'text/html'}, 'temporary')]:
            session = Session([(status, body, final, headers)])
            with self.assertRaises(SourceFailure) as caught:
                Client(session).request(self.quote_request())
            self.assertEqual(caught.exception.state, state)
            self.assertEqual(len(session.calls), 1)
        session = Session([TimeoutError()])
        with self.assertRaises(SourceFailure):
            Client(session).request(self.quote_request())
        self.assertEqual(len(session.calls), 1)

    def test_quote_partial_denial_retains_priority_over_body_errors(self):
        for status in (403, 429):
            session = Session([(status, 'x' * 3_000_001, self.quote_request()['url'], {'retry-after': '604800'})])
            with self.assertRaises(SourceFailure) as caught:
                Client(session).request(self.quote_request())
            self.assertEqual(caught.exception.state, 'blocked' if status == 403 else 'rate_limited')
            self.assertIsNotNone(caught.exception.retry_after_at)
            self.assertEqual(len(session.calls), 1)

    def test_quote_body_and_ipc_size_limits(self):
        from unittest.mock import patch
        from amazon_bridge import MAX_QUOTE_BODY
        url = self.quote_request()['url']
        for body, code in [('x' * MAX_QUOTE_BODY, None), ('x' * (MAX_QUOTE_BODY + 1), 'amazon_response_too_large'),
                           ('\u3042' * (MAX_QUOTE_BODY // 3 + 1), 'amazon_response_too_large')]:
            session = Session([(200, body, url, {'content-type': 'text/html'})])
            if code:
                with self.assertRaises(SourceFailure) as caught:
                    Client(session).request(self.quote_request())
                self.assertEqual(caught.exception.quote_code, code)
            else:
                self.assertEqual(Client(session).request(self.quote_request())['result']['htmlBytes'], MAX_QUOTE_BODY)
        with patch('amazon_bridge.MAX_QUOTE_COMPRESSED', 1):
            with self.assertRaises(SourceFailure) as caught:
                Client(Session([(200, HTML, url, {'content-type': 'text/html'})])).request(self.quote_request())
            self.assertEqual(caught.exception.quote_code, 'amazon_response_too_large')

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

    def test_ratings_and_undated_reviews_do_not_fabricate_evidence(self):
        html = HTML + '<span id="acrCustomerReviewText">10,000 ratings</span><div data-hook="review"><span data-hook="review-date">2026</span><span data-hook="avp-badge">Verified Purchase</span></div>'
        self.assertNotIn('amazonMetrics', detail(html, ASIN, CATEGORY, OBSERVED))

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
        for responses in [[(503, '')] * 2, [TimeoutError()] * 2]:
            session = Session(responses)
            with self.assertRaises(SourceFailure) as context:
                Client(session, lambda _: None).fetch('https://www.amazon.co.jp/dp/' + ASIN)
            self.assertEqual(context.exception.state, 'temporary')
            self.assertEqual(len(session.calls), 2)

    def test_denial_and_challenges_latch(self):
        for response in [(403, ''), (200, '<input id="captchacharacters">'), (200, '<form action="/ap/signin">')]:
            session = Session([response])
            client = Client(session, lambda _: None)
            for _ in range(2):
                with self.assertRaises(SourceFailure) as context:
                    client.fetch('https://www.amazon.co.jp/dp/' + ASIN)
                self.assertEqual(context.exception.state, 'blocked')
            self.assertEqual(len(session.calls), 1)

    def test_rate_limit_without_explicit_permission_cools_down_without_retry(self):
        session = Session([(429, '')] * 3)
        waits = []
        client = Client(session, waits.append)
        for _ in range(2):
            with self.assertRaises(SourceFailure) as context:
                client.fetch('https://www.amazon.co.jp/dp/' + ASIN)
            self.assertEqual(context.exception.state, 'rate_limited')
        self.assertEqual(len(session.calls), 1)
        self.assertGreaterEqual(client.pace, 2.4)
        self.assertEqual(waits, [])

    def test_rate_limit_then_transient_exhaustion_still_cools_down(self):
        for tail in [TimeoutError(), (503, '')]:
            session = Session([(429, '', 'https://www.amazon.co.jp/dp/' + ASIN, {'retry-after': '3'}), tail])
            client = Client(session, lambda _: None)
            for _ in range(2):
                with self.assertRaises(SourceFailure) as context:
                    client.fetch('https://www.amazon.co.jp/dp/' + ASIN)
                self.assertEqual(context.exception.state, 'rate_limited')
            self.assertEqual(len(session.calls), 2)

    def test_long_retry_after_is_carried_to_durable_source_gate(self):
        session = Session([(429, '', 'https://www.amazon.co.jp/dp/' + ASIN, {'retry-after': '172800'})])
        client = Client(session, lambda _: None)
        with self.assertRaises(SourceFailure) as caught:
            client.fetch('https://www.amazon.co.jp/dp/' + ASIN)
        self.assertEqual(caught.exception.state, 'rate_limited')
        deadline = datetime.fromisoformat(caught.exception.retry_after_at)
        self.assertGreater((deadline - datetime.now(timezone.utc)).total_seconds(), 170000)
        self.assertEqual(len(session.calls), 1)

    def test_rate_limit_retry_after_and_success(self):
        session = Session([(429, '', 'https://www.amazon.co.jp/dp/' + ASIN, {'retry-after': '7'}), (200, HTML)])
        waits = []
        client = Client(session, waits.append)
        self.assertIn('productTitle', client.fetch('https://www.amazon.co.jp/dp/' + ASIN)[0])
        self.assertEqual(len(session.calls), 2)
        self.assertIn(120, waits)
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
            client = Client(session, waits.append)
            if header != 'invalid':
                client.fetch('https://www.amazon.co.jp/dp/' + ASIN)
                self.assertEqual(len(session.calls), 2)
                self.assertEqual(waits[0], 120)
                self.assertTrue(all(value >= 0 for value in waits))
            else:
                with self.assertRaises(SourceFailure) as context:
                    client.fetch('https://www.amazon.co.jp/dp/' + ASIN)
                self.assertEqual(context.exception.state, 'rate_limited')
                self.assertEqual(len(session.calls), 1)
                self.assertEqual(waits, [])

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
        session = Session([(429, '', 'https://www.amazon.co.jp/dp/' + ASIN, {'retry-after': '4'}), (200, '<input id="captchacharacters">')])
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

    def test_real_amazon_parsejson_gallery_keeps_five_hires_without_thumbnails(self):
        # Amazon embeds the nine observed hiRes items in a JS string wrapper,
        # not a literal JSON array as in the older test fixture.
        import json
        asin = 'B0D32RZY9M'
        rows = [dict(hiRes=f'https://m.media-amazon.com/images/I/photo{i}._AC_SL1500_.jpg',
                     thumb=f'https://m.media-amazon.com/images/I/photo{i}._AC_SR38,50_.jpg')
                for i in range(9)]
        source = json.dumps(rows, separators=(',', ':'))
        html = (f'<input id="ASIN" value="{asin}"><span id="productTitle">Baby food imported from Japan</span><img id="landingImage" '
                f'src="{rows[0]["hiRes"]}"><div id="altImages">'
                f'<img src="{rows[1]["thumb"]}"></div>'
                f"<script>var data={{'currentAsin':'{asin}','colorImages':"
                f"{{'initial': A.$.parseJSON('{source}')}}}};</script>")
        result = detail(html, asin, CATEGORY, OBSERVED)
        self.assertIn('colorImages.initial', result['detail']['provenance']['sections'])
        self.assertIn('gallery:complete', result['detail']['provenance']['sections'])
        self.assertEqual(result['imageUrls'][:5], [row['hiRes'] for row in rows[:5]])
        self.assertFalse(any('SR38,50' in url for url in result['imageUrls']))

    def test_selected_gallery_skips_explicit_short_edge_even_if_first_hires(self):
        asin = ASIN
        large = 'https://m.media-amazon.com/images/I/photo._AC_SL1500_.jpg'
        tiny = 'https://m.media-amazon.com/images/I/photo._AC_SR1200,120_.jpg'
        html = (f'<input id="ASIN" value="{asin}"><span id="productTitle">Test infant cereal</span>'
                f'<img id="landingImage" src="{large}"><script>'
                f'{{"currentAsin":"{asin}","colorImages":{{"initial":['
                f'{{"hiRes":"{tiny}","large":"{large}"}}]}}}}</script>')
        result = detail(html, asin, CATEGORY, OBSERVED)
        self.assertEqual(result['imageUrls'], [large])
        self.assertIn('gallery:complete', result['detail']['provenance']['sections'])

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
