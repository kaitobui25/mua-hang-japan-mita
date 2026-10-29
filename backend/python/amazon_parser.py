"""Offline-testable BeautifulSoup parser; never executes page scripts."""
import ast
import json
import re
from datetime import datetime, timezone
from urllib.parse import urlsplit
from bs4 import BeautifulSoup

# Raw HTML does not establish review publication rights or exact-ASIN dated
# written-review evidence. Keep amazonMetrics absent; never infer it from stars.
ASIN = re.compile(r'^[A-Z0-9]{10}$')

def text(node):
    return ' '.join(node.stripped_strings) if node else ''

def property_source(script, key):
    match = re.search(r'["\']' + re.escape(key) + r'["\']\s*:\s*', script)
    if not match:
        return None
    start = match.end()
    if start >= len(script):
        return None
    first = script[start]
    if first not in '{[':
        try:
            _, end = json.JSONDecoder().raw_decode(script[start:])
            return script[start:start + end]
        except ValueError:
            return None
    depth, quote, escaped = 0, None, False
    for index in range(start, len(script)):
        char = script[index]
        if escaped:
            escaped = False
            continue
        if quote:
            if char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in ('"', "'"):
            quote = char
        elif char in '{[':
            depth += 1
        elif char in '}]':
            depth -= 1
            if depth == 0:
                return script[start:index + 1]
    return None

def field(script, key):
    source = property_source(script, key)
    if source:
        try:
            return json.loads(source)
        except ValueError:
            pass

def selected_gallery_initial(color):
    """Decode only colorImages.initial, including Amazon's JS-wrapped JSON string.

    Neither the wrapper nor anything else from a page is executed.  A fixture
    with literal JSON continues to use the existing conservative parser.
    """
    if not color:
        return None
    direct = field(color, 'initial')
    if isinstance(direct, list):
        return direct
    if not color or len(color) > 250_000:
        return None
    wrapper = re.search(
        r"""['"]initial['"]\s*:\s*(?:A\.\$\.parseJSON|JSON\.parse)\(\s*"""
        r"""('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")\s*\)""", color)
    if not wrapper or len(wrapper[1]) > 200_000:
        return None
    try:
        literal = ast.literal_eval(wrapper[1])
        result = json.loads(literal)
        return result if isinstance(result, list) and len(result) <= 40 else None
    except (ValueError, SyntaxError, TypeError, RecursionError):
        return None

def canonical(url):
    p = urlsplit(url)
    if p.scheme != 'https' or p.netloc not in ('www.amazon.co.jp', 'amazon.co.jp'):
        raise ValueError('Noncanonical Amazon URL')
    return p

def identity(url):
    p = canonical(url)
    m = re.search(r'/(?:dp|gp/product)/([A-Z0-9]{10})(?:/|$)', p.path)
    if not m:
        raise ValueError('Missing canonical ASIN')
    return m[1]

def image(url):
    if not isinstance(url, str):
        return False
    p = urlsplit(url)
    return p.scheme == 'https' and p.netloc in ('m.media-amazon.com', 'images-na.ssl-images-amazon.com', 'images-fe.ssl-images-amazon.com') and bool(re.search(r'\.(jpg|jpeg|png|webp)$', p.path, re.I))

def image_key(url):
    return re.sub(r'\._[^/]+_\.', '.', urlsplit(url).path)

def image_not_thumbnail(url):
    if not image(url):
        return False
    filename = urlsplit(url).path
    modifier = re.search(r'\._([^/]+)_\.(?:jpe?g|png|webp)$', filename, re.I)
    if not modifier:
        return True  # Unknown dimensions are retained as source-observed, not certified.
    for match in re.finditer(r'(?:^|_)(?:AC_)?(?:SL|SX|SY|SR|US|UX|UY|UL|SS|SH)(\d+)(?:,(\d+))?(?=_|$)', modifier[1], re.I):
        if int(match[1]) < 800 or (match[2] and int(match[2]) < 800):
            return False
    return True

def price(value):
    m = re.search(r'[¥￥]\s*([0-9,]+)(?:\.[0-9]{1,2})?', value.replace(' ', ''))
    if not m:
        return None
    digits = m[1]
    if re.fullmatch(r'\d{1,3}(?:,\d{3})+\d{2}', digits):
        digits = digits[:-2]
    if not re.fullmatch(r'(?:\d{1,5}|\d{1,3}(?:,\d{3})+)', digits):
        return None
    n = int(digits.replace(',', ''))
    return n if 0 < n <= 100000 else None

def listing(html, category, observed):
    soup = BeautifulSoup(html, 'html.parser')
    found = {}
    selector = 'div[data-component-type="s-search-result"][data-asin]' if category == 'thuc-pham-cho-be' else '[data-asin]'
    for card in soup.select(selector):
        asin = card.get('data-asin', '').upper()
        if not ASIN.fullmatch(asin) or asin in found:
            continue
        pic = card.select_one('img[alt]')
        name = text(card.select_one('h2')) or (pic.get('alt', '').strip() if pic else '') or text(card.select_one('[class*="line-clamp"], [class*="truncate"]'))
        if len(name) < 8:
            continue
        raw = (pic.get('data-src') or pic.get('src')) if pic else None
        parent = card.get('data-parent-asin', '').upper()
        family = card.get('data-product-family-id', '')
        found[asin] = dict(asin=asin, name=name[:500], categorySlug=category, sourceUrl=f'https://www.amazon.co.jp/dp/{asin}', imageUrl=raw if image(raw) else None, priceJpy=price(text(card.select_one('.p13n-sc-price, .a-price .a-offscreen'))), observedAt=observed, sourceAdapter='scrapling-listing', parentAsin=parent if ASIN.fullmatch(parent) else None, sourceProductId=family if re.fullmatch(r'[A-Za-z0-9_-]{3,64}', family) else None)
    return list(found.values())

def detail(html, asin, category, observed):
    soup = BeautifulSoup(html, 'html.parser')
    identities = [n.get('value', '').strip().upper() for n in soup.select('input#ASIN, input[name="ASIN"]')]
    for n in soup.select('link[rel="canonical"]'):
        identities.append(identity(n.get('href', '')))
    if not identities or any(value != asin for value in identities):
        raise ValueError('Detail ASIN identity mismatch')
    source = f'https://www.amazon.co.jp/dp/{asin}'
    name = text(soup.select_one('#productTitle'))
    sections = []
    images = {}
    known = set()
    def selected(node):
        for ancestor in [node, *node.parents]:
            node_id = ancestor.get('id', '')
            if re.search(r'recommend|sims-|^variation_', node_id, re.I):
                return False
            owner = ancestor.get('data-asin')
            if owner and owner != asin:
                return False
        return True
    def candidates(node):
        urls = [node.get('data-old-hires')]
        dynamic = node.get('data-a-dynamic-image', '{}')
        try:
            sizes = json.loads(dynamic)
            if isinstance(sizes, dict):
                urls.extend(sizes)
        except ValueError:
            sizes = {}
        urls.append(node.get('src'))
        return urls, sizes
    def add(url, sizes=None):
        if not image_not_thumbnail(url):
            return
        size = (sizes or {}).get(url)
        area = size[0] * size[1] if isinstance(size, list) and len(size) == 2 and all(isinstance(n, (int, float)) and n > 0 for n in size) else 0
        m = re.search(r'(?:SL|SX|SY)(\d+)', url)
        area = area or (int(m[1]) ** 2 if m else 0)
        key = image_key(url)
        if key not in images or area > images[key][1]:
            images[key] = (url, area)
    dom = [n for n in soup.select('#landingImage, #imgBlkFront, #altImages img') if selected(n)]
    for node in dom:
        urls, _ = candidates(node)
        known.update(image_key(u) for u in urls if image(u))
    # Main product image first, then the explicitly bound selected gallery.
    for node in dom:
        add(node.get('data-old-hires'))
    scripts = [n for n in soup.select('script') if selected(n)]
    for node in scripts:
        script = node.string or node.get_text()
        current = field(script, 'currentAsin')
        if current is not None and current != asin:
            continue
        # Amazon may wrap its actual JSON list in A.$.parseJSON('...').
        color = property_source(script, 'colorImages')
        initial = selected_gallery_initial(color)
        if not isinstance(initial, list):
            continue
        owner = next((a.get('data-asin') for a in [node, *node.parents] if a.get('data-asin')), None)
        def row_urls(row):
            return [row.get('hiRes'), row.get('large'), row.get('thumb'), *list(row.get('main', {}) if isinstance(row.get('main'), dict) else {})] if isinstance(row, dict) else []
        if owner != asin and current != asin and not any(image(u) and image_key(u) in known for row in initial for u in row_urls(row)):
            continue
        valid = 0
        for row in initial:
            if not isinstance(row, dict):
                continue
            main = row.get('main') if isinstance(row.get('main'), dict) else {}
            # A row represents one gallery photo. Its hiRes, large and main
            # entries can have DIFFERENT Amazon IDs for different sizes. Do
            # not treat all sizes as distinct gallery photos.
            choices = [row.get('hiRes'), row.get('large'), *main.keys()]
            selected_url = next((u for u in choices if image_not_thumbnail(u)), None)
            if selected_url:
                valid += 1
                add(selected_url, main)
        if valid:
            sections.append('colorImages.initial')
            sections.append('gallery:complete' if valid == len(initial) else 'gallery:partial')
    for node in dom:
        # A complete, selected gallery has the actual images. Adding altImages
        # again would append unrelated low-resolution 38x50 thumbnails.
        if 'gallery:complete' not in sections:
            urls, sizes = candidates(node)
            for u in urls:
                add(u, sizes)
        sections.append('altImages' if node.find_parent(id='altImages') else 'landingImage')
    image_urls = [v[0] for v in images.values()]
    if image_urls and not any(s.startswith('gallery:') for s in sections):
        sections.append('gallery:partial')
    data = dict(features=[], ingredients=[], usage=[], specs={}, cautions=[], variantAttributes={}, childAsins=[])
    def add_text(key, value, section):
        if value and value not in data[key]:
            data[key].append(value)
            sections.append(section)
    def classify(label):
        return 'ingredients' if re.search('原材料|成分|ingredients', label, re.I) else 'usage' if re.search('使用方法|使い方|お召し上がり|召し上がり方|directions|usage', label, re.I) else 'cautions' if re.search('注意|警告|安全|caution|warning|safety', label, re.I) else None
    for node in soup.select('#feature-bullets li .a-list-item, #productDescription p'):
        add_text('features', text(node), 'feature-bullets' if node.find_parent(id='feature-bullets') else 'productDescription')
    for node in soup.select('#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #productOverview_feature_div tr'):
        label, value = text(node.select_one('th, td.a-span3')), text(node.select('td')[-1]) if node.select('td') else ''
        if label and value and label != value:
            data['specs'][label] = value
            sections.append('productDetails')
            key = classify(label)
            if key:
                add_text(key, value, 'productDetails')
    for node in soup.select('#detailBullets_feature_div li'):
        bold = node.select_one('.a-text-bold')
        if bold:
            label = text(bold).strip(':：\u200e\u200f ')
            bold.extract()
            value = text(node).strip(':： ')
            if label and value:
                data['specs'][label] = value
                sections.append('detailBullets')
                if classify(label):
                    add_text(classify(label), value, 'detailBullets')
    for heading in soup.select('#important-information h1, #important-information h2, #important-information h3, #important-information h4'):
        key = classify(text(heading))
        if key:
            parts = []
            for sibling in heading.next_siblings:
                if getattr(sibling, 'name', None) in ('h1', 'h2', 'h3', 'h4'):
                    break
                parts.append(text(sibling) if getattr(sibling, 'name', None) else str(sibling).strip())
            add_text(key, ' '.join(p for p in parts if p), 'important-information')
    parent = None
    children = set()
    for node in scripts:
        script = node.string or node.get_text()
        if field(script, 'currentAsin') not in (None, asin):
            continue
        variations = field(script, 'asinVariationValues') or {}
        display = field(script, 'dimensionValuesDisplayData') or {}
        if not isinstance(variations, dict) or not isinstance(display, dict):
            continue
        if asin not in variations and asin not in display and field(script, 'currentAsin') != asin:
            continue
        p = field(script, 'parentAsin')
        if isinstance(p, str) and ASIN.fullmatch(p):
            parent = p
        values = field(script, 'variationValues') or {}
        labels = field(script, 'variationDisplayLabels') or {}
        names = field(script, 'dimensions') or []
        children.update(k for k in [*variations, *display] if ASIN.fullmatch(k))
        selected_values = variations.get(asin, {})
        if isinstance(selected_values, dict):
            for key, value in selected_values.items():
                choices = values.get(key) if isinstance(values, dict) else None
                resolved = choices[int(value)] if str(value).isdigit() and isinstance(choices, list) and int(value) < len(choices) else value if not str(value).isdigit() else None
                if isinstance(resolved, str):
                    data['variantAttributes'][labels.get(key, key) if isinstance(labels, dict) else key] = resolved
        selected_values = display.get(asin)
        if isinstance(names, list) and isinstance(selected_values, list) and len(names) == len(selected_values):
            data['variantAttributes'].update({k: v for k, v in zip(names, selected_values) if isinstance(k, str) and isinstance(v, str)})
    for node in soup.select('[id^="variation_"]'):
        if any(re.search(r'recommend|sims-', owner.get('id', ''), re.I) or (owner.get('data-asin') and owner.get('data-asin') != asin) for owner in [node, *node.parents]):
            continue
        key = node['id'][10:]
        value = text(node.select_one('.selection'))
        if value:
            data['variantAttributes'][key] = value
        for child in node.select('[data-defaultasin], [data-asin], [data-dp-url], a[href], option[value]'):
            child_id = child.get('data-defaultasin') or child.get('data-asin')
            if not child_id and child.name == 'option' and ASIN.fullmatch(child.get('value', '')):
                child_id = child['value']
            if not child_id and (child.get('href') or child.get('data-dp-url')):
                href = child.get('href') or child['data-dp-url']
                try:
                    child_id = identity('https://www.amazon.co.jp' + href if href.startswith('/') and not href.startswith('//') else href)
                except ValueError:
                    continue
            if child_id and ASIN.fullmatch(child_id):
                children.add(child_id)
    data['childAsins'] = sorted(children - {asin})
    if parent or data['childAsins'] or data['variantAttributes']:
        sections.append('twister')
    provenance = dict(sourceUrl=source, adapter='scrapling-detail', sections=list(dict.fromkeys(sections)), fieldObservedAt={k: observed for k, v in data.items() if v})
    if image_urls:
        provenance['fieldObservedAt']['images'] = observed
    if parent:
        provenance['variantGroup'] = dict(parentAsin=parent, sourceUrl=source)
    data.update(sourceObservedAt=observed, provenance=provenance)
    if len(name) < 8 or not image_urls:
        raise ValueError('Detail lacks valid title or Amazon gallery')
    availability = text(soup.select_one('#availability'))
    return dict(asin=asin, name=name[:500], categorySlug=category, sourceUrl=source, imageUrl=image_urls[0], imageUrls=image_urls, priceJpy=price(text(soup.select_one('#corePriceDisplay_desktop_feature_div .a-price .a-offscreen, #corePrice_feature_div .a-price .a-offscreen, #priceblock_ourprice'))), observedAt=observed, sourceAdapter='scrapling-detail', parentAsin=parent, detail=data, availability='out_of_stock' if re.search('在庫切れ|現在お取り扱いできません|currently unavailable|out of stock', availability, re.I) else 'in_stock' if re.search('在庫あり|in stock', availability, re.I) else 'unknown')
