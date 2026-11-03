import json
import os
import sys
import time
import base64
import zlib
from datetime import datetime, timezone, timedelta
for line in sys.stdin:
    request = json.loads(line)
    asin = request.get('asin')
    if asin == 'B000000002':
        time.sleep(30)
    if asin == 'B000000003':
        print('x' * (2 * 1024 * 1024 + 1), flush=True)
        continue
    if asin == 'B000000004':
        print(json.dumps(dict(id=request['id'], ok=False, state='blocked', message='fixture CAPTCHA')), flush=True)
        continue
    if request.get('op') == 'quote':
        body = '\u65e5\u672c\u8a9e fixture'.encode('utf-8')
        observed = datetime.now(timezone.utc)
        result = dict(asin=asin, quantity=request['quantity'], url=request['url'],
                      observedAt=observed.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                      htmlBytes=len(body), htmlZlibBase64=base64.b64encode(zlib.compress(body)).decode())
        if asin == 'B000000005': result['url'] = 'https://evil.test/dp/' + asin
        if asin == 'B000000006': result['asin'] = 'B000000001'
        if asin == 'B000000007': result['quantity'] = 2
        if asin == 'B000000008': result['observedAt'] = 'invalid'
        if asin == 'B000000009': result['observedAt'] = '2020-01-01T00:00:00.000Z'
        if asin == 'B000000010': result['observedAt'] = (observed + timedelta(days=1)).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        if asin == 'B000000011': result['htmlZlibBase64'] = 'abcd'
        if asin == 'B000000012': result['htmlBytes'] = 1
        if asin in ('B000000013', 'B000000017'):
            body = b'x' * (3_000_001 if asin == 'B000000013' else 3_000_000)
            result.update(htmlBytes=3_000_000, htmlZlibBase64=base64.b64encode(zlib.compress(body)).decode())
        if asin == 'B000000014':
            result.update(htmlBytes=1, htmlZlibBase64=base64.b64encode(zlib.compress(b'\xff')).decode())
        if asin == 'B000000015':
            print(json.dumps(dict(id=request['id'], ok=False, state='rate_limited', message='fixture', retryAfterAt='2030-01-01T00:00:00.000Z')), flush=True)
            continue
        if asin == 'B000000016': result['htmlBytes'] = 3_000_001
        if asin == 'B000000018': result['htmlZlibBase64'] = 'a' * 2_000_004
        if asin == 'B000000019': result['url'] = request['url'].replace('quantity=1', 'quantity=2')
        print(json.dumps(dict(id=request['id'], ok=True, result=result)), flush=True)
        continue
    result = dict(asin=asin, categorySlug=request['category'], name='日本語 fixture', sourceUrl='https://www.amazon.co.jp/dp/' + asin, sourceAdapter='fixture', observedAt='2026-10-28T00:00:00Z', secretPresent=any(k in os.environ for k in ('DATABASE_URL', 'OPENROUTER_API_KEY')))
    print(json.dumps(dict(id=request['id'], ok=True, status=200, url=result['sourceUrl'], result=result), ensure_ascii=False), flush=True)
