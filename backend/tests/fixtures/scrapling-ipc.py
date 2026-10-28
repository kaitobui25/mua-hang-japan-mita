import json
import os
import sys
import time
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
    result = dict(asin=asin, categorySlug=request['category'], name='日本語 fixture', sourceUrl='https://www.amazon.co.jp/dp/' + asin, sourceAdapter='fixture', observedAt='2026-10-28T00:00:00Z', secretPresent=any(k in os.environ for k in ('DATABASE_URL', 'OPENROUTER_API_KEY')))
    print(json.dumps(dict(id=request['id'], ok=True, status=200, url=result['sourceUrl'], result=result), ensure_ascii=False), flush=True)
