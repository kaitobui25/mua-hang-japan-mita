import { amazonInputAsin } from "@/lib/amazon-input";
import type { AmazonBrowserCapture } from "@/types/amazon-quote";

export const AMAZON_CAPTURE_MAX_LENGTH = 8000;

/** Runs only when the user invokes the bookmark on the Amazon product page.
 * Reads product DOM only; no network requests, cookies or account information. */
function captureProduct(mitaPage: string) {
  const asin = location.pathname.match(/\/(?:dp|gp\/(?:product|aw\/d))\/([a-z0-9]{10})(?:\/|$)/i)?.[1].toUpperCase();
  const visible = (node: Element) => {
    for (let element: Element | null = node; element; element = element.parentElement) {
      if (element.matches('[hidden], [aria-hidden="true"], .aok-hidden, .a-hidden')) return false;
      if (typeof getComputedStyle === "function") {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
      }
    }
    return true;
  };
  // In a real browser innerText excludes hidden descendants. Never fall back
  // to textContent when innerText is an intentionally empty string.
  const visibleText = (node: Element) => {
    const value = typeof (node as HTMLElement).innerText === "string"
      ? (node as HTMLElement).innerText : (node.textContent ?? "");
    return value.replace(/\s+/g, " ").trim();
  };
  const read = (selector: string) => Array.from(document.querySelectorAll(selector))
    .filter(visible).map(visibleText).find(Boolean);
  if (location.protocol !== "https:" || !["amazon.co.jp", "www.amazon.co.jp"].includes(location.hostname) ||
      !asin || document.querySelector('#captchacharacters, form[action*="validateCaptcha"]')) {
    alert("Hãy mở trang sản phẩm Amazon.co.jp. Không thể lấy dữ liệu từ trang xác minh truy cập.");
    return;
  }
  const selected = document.querySelector<HTMLInputElement>('input#ASIN')?.value?.toUpperCase();
  if (selected && selected !== asin) {
    alert("ASIN phiên bản đang chọn không khớp link. Hãy sao chép đúng URL phiên bản đang xem.");
    return;
  }
  const title = read("#productTitle");
  if (!title) { alert("Chưa tìm thấy thông tin sản phẩm trên trang này."); return; }
  const priceText = read('#desktop_buybox #newAccordionRow_0.a-accordion-active .apex-pricetopay-value .a-offscreen') ||
    read('#desktop_buybox #corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen, #desktop_buybox #price_inside_buybox') ||
    read('#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen, #corePrice_feature_div .priceToPay .a-offscreen');
  const price = priceText?.match(/^[￥¥]\s*(\d{1,3}(?:,\d{3})+|\d{1,8})(?:\.00)?$/)?.[0];
  const image = document.querySelector<HTMLImageElement>("#landingImage, #imgBlkFront");
  const imageUrl = image?.getAttribute("data-old-hires") || image?.src;
  const features = Array.from(document.querySelectorAll("#feature-bullets li .a-list-item"))
    .filter(visible).map(visibleText).filter(value => !!value && value.length <= 400).slice(0, 10);
  const brand = read("#bylineInfo")?.slice(0, 500);
  const seller = read("#sellerProfileTriggerId")?.slice(0, 500);
  const variantText = read("#twister .selection, #variation_color_name .selection, #variation_size_name .selection")?.slice(0, 300);
  const availabilityText = read("#availability span, #availability")?.slice(0, 300);
  const deliveryText = read("#mir-layout-DELIVERY_BLOCK-slot, #mir-layout-DELIVERY_BLOCK")?.slice(0, 400);
  let images: string[] = [];
  if (imageUrl) {
    try {
      const url = new URL(imageUrl);
      if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
          /^(?:[a-z0-9-]+\.)*media-amazon\.com$/.test(url.hostname) && url.pathname.startsWith("/images/I/")) images = [imageUrl];
    } catch { /* Missing image is allowed. */ }
  }
  const capture: AmazonBrowserCapture = {
    quantity: 1,
    page: { asin, title: title.slice(0, 1000), url: `https://www.amazon.co.jp/dp/${asin}` },
  };
  // Keep this function self-contained when serialized into a bookmark URL.
  if (price) capture.page.priceText = price;
  if (brand) capture.page.brand = brand;
  if (seller) capture.page.seller = seller;
  if (variantText) capture.page.variantText = variantText;
  if (availabilityText) capture.page.availabilityText = availabilityText;
  if (deliveryText) capture.page.deliveryText = deliveryText;
  if (images.length) capture.page.images = images;
  if (features.length) capture.page.features = features;
  while (new TextEncoder().encode(JSON.stringify(capture)).length > 8000 && capture.page.features?.length) capture.page.features.pop();
  const json = JSON.stringify(capture);
  if (new TextEncoder().encode(json).length > 8000) {
    alert("Thông tin sản phẩm quá dài để gửi an toàn. Hãy thử sản phẩm khác hoặc liên hệ Mita.");
    return;
  }
  // The customer deliberately opens the Mita tab. JSON stays in a URL fragment
  // (never sent in HTTP); Mita removes it before POSTing selected fields.
  const target = mitaPage + "#browser_capture=" + encodeURIComponent(json);
  if (target.length <= 24000) {
    const tab = window.open(target, "_blank");
    if (tab) { tab.opener = null; return; }
  }
  // Clipboard is a fallback for popup blockers and browsers without bookmarks.
  void navigator.clipboard?.writeText(json).then(() => alert("Đã sao chép thông tin sản phẩm. Quay lại Mita và dán vào ô dữ liệu."))
    .catch(() => prompt("Sao chép dữ liệu này rồi dán vào Mita:", json));
  if (!navigator.clipboard) prompt("Sao chép dữ liệu này rồi dán vào Mita:", json);
}

export function amazonCaptureBookmarklet(mitaPage: string): string {
  return `javascript:${encodeURIComponent(`void (${captureProduct.toString()})("${mitaPage.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}")`)}`;
}

/** Project only observed fields; client input cannot supply a quote, rights or request ID. */
export function parseAmazonBrowserCapture(input: string, expectedAsin: string): AmazonBrowserCapture {
  if (new TextEncoder().encode(input).length > AMAZON_CAPTURE_MAX_LENGTH) throw new Error("Dữ liệu quá dài. Hãy lấy lại thông tin sản phẩm.");
  let raw: unknown;
  try { raw = JSON.parse(input); } catch { throw new Error("Dữ liệu không hợp lệ. Hãy dán đầy đủ dữ liệu đã sao chép từ Amazon."); }
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!object(raw) || !object(raw.page)) throw new Error("Không đúng định dạng dữ liệu trình duyệt Mita.");
  const page = raw.page;
  if (typeof page.url !== "string" || amazonInputAsin(page.url) !== expectedAsin || page.asin !== expectedAsin) {
    throw new Error("Dữ liệu không khớp sản phẩm đang xem. Hãy mở đúng link Amazon và lấy lại.");
  }
  const content = (value: unknown, max: number): value is string => typeof value === "string" && !!value.trim() && value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
  if (!content(page.title, 1000)) throw new Error("Dữ liệu thiếu tên sản phẩm hợp lệ.");
  const clean: AmazonBrowserCapture['page'] = { asin: expectedAsin, url: `https://www.amazon.co.jp/dp/${expectedAsin}`, title: page.title.trim() };
  for (const key of ['brand', 'seller', 'priceText', 'variantText', 'availabilityText', 'deliveryText'] as const) {
    if (page[key] === undefined) continue;
    const max = key === 'priceText' ? 80 : key === 'deliveryText' ? 400 :
      key === 'availabilityText' || key === 'variantText' ? 300 : 500;
    if (!content(page[key], max)) throw new Error("Dữ liệu sản phẩm không hợp lệ.");
    clean[key] = page[key];
  }
  if (clean.priceText && !/^[￥¥]\s*(\d{1,3}(?:,\d{3})+|\d{1,8})(?:\.00)?$/.test(clean.priceText)) throw new Error("Giá Amazon phải là một số tiền JPY rõ ràng.");
  if (clean.priceText) {
    const amount = Number(clean.priceText.replace(/[￥¥\s,]/g, ""));
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 100000000) throw new Error("Giá Amazon nằm ngoài phạm vi hỗ trợ.");
  }
  for (const key of ['images', 'features'] as const) {
    const values = page[key];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length > 10 || !values.every(value => content(value, key === 'images' ? 2048 : 400))) throw new Error("Dữ liệu sản phẩm không hợp lệ.");
    if (key === 'images' && !values.every(value => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !url.port &&
          !/[\s\u0000-\u001f\u007f]/.test(value) && /^(?:[a-z0-9-]+\.)*media-amazon\.com$/.test(url.hostname) && url.pathname.startsWith('/images/I/');
      } catch { return false; }
    })) throw new Error("Đường dẫn ảnh sản phẩm không hợp lệ.");
    clean[key] = values;
  }
  return { page: clean, quantity: 1 };
}
