import { amazonInputAsin } from "@/lib/amazon-input";
import type { AmazonQuote, AmazonQuoteDisplay, AmazonObservedDetails, AmazonSourcePreview } from "@/types/amazon-quote";

type DateRange = { start: string; end: string } | null;
type ServerQuote = {
  id: string; asin: string; title: string; seller: string; sourceUrl: string; imageUrl: string | null;
  display?: AmazonQuoteDisplay;
  quantity: number; priceJpy: number; unitPriceVnd: number; observedAt: string; expiresAt: string;
  deliveryDays: number; amazonDelivery: DateRange; vietnamDelivery: DateRange;
  freeJapanShipping: true; shippingEvidence: string; variant: string; offerId: string;
  purchaseType: string; shippingType: string; pricingPolicy: { fxJpyToVnd: number; serviceFeePercent: number };
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= max;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function image(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      /^(?:[a-z0-9-]+\.)*media-amazon\.com$/.test(url.hostname) && url.pathname.startsWith("/images/I/");
  } catch { return false; }
}

/** Only product-scoped plain text and explicitly allowlisted Amazon image URLs. */
function parseObservedDetails(value: unknown): AmazonObservedDetails | undefined {
  if (!record(value)) return;
  const display: AmazonObservedDetails = {};
  for (const [key, limit] of [["brand", 500], ["description", 12000], ["ingredients", 4000], ["usage", 4000], ["warnings", 4000]] as const) {
    if (text(value[key], limit)) display[key] = value[key];
  }
  if (Array.isArray(value.images)) display.images = [...new Set(value.images.filter(image))].slice(0, 10);
  if (Array.isArray(value.features)) display.features = value.features.filter((v): v is string => text(v, 2000)).slice(0, 20);
  if (Array.isArray(value.specifications)) display.specifications = value.specifications
    .filter((v): v is { name: string; value: string } => record(v) && text(v.name, 500) && text(v.value, 2000))
    .slice(0, 40).map(({ name, value }) => ({ name, value }));
  const rating = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 5;
  if (rating(value.rating)) display.rating = value.rating;
  if (Number.isSafeInteger(value.reviewCount) && Number(value.reviewCount) >= 0 && Number(value.reviewCount) <= 1000000000) display.reviewCount = Number(value.reviewCount);
  if (Array.isArray(value.reviews)) display.reviews = value.reviews.filter(v => record(v) && text(v.body, 4000)).slice(0, 10)
    .map(v => ({ body: v.body as string, ...(text(v.title, 500) ? { title: v.title } : {}), ...(rating(v.rating) ? { rating: v.rating } : {}) }));
  return Object.keys(display).length ? display : undefined;
}

/** Quote display still requires a trusted backend rights decision. */
function parseDisplay(value: unknown, asin: string, sourceUrl: string): AmazonQuoteDisplay | undefined {
  if (!record(value) || !record(value.provenance)) return;
  const provenance = value.provenance;
  if (provenance.asin !== asin || provenance.sourceUrl !== sourceUrl || !timestamp(provenance.observedAt) ||
      !text(provenance.permissionReference, 500)) return;
  return { provenance: { asin, sourceUrl, observedAt: provenance.observedAt,
    permissionReference: provenance.permissionReference }, ...parseObservedDetails(value) };
}

function projectQuote(raw: ServerQuote): AmazonQuote {
  // The comparison key represents offer and displayed terms, not the issued quote id/time.
  const fingerprint = JSON.stringify([raw.asin,raw.sourceUrl,raw.title,raw.variant,raw.seller,raw.offerId,raw.quantity,
    raw.priceJpy,raw.unitPriceVnd,raw.imageUrl,raw.purchaseType,raw.shippingType,raw.freeJapanShipping,
    raw.shippingEvidence,raw.amazonDelivery?.start,raw.amazonDelivery?.end,raw.deliveryDays,
    raw.vietnamDelivery?.start,raw.vietnamDelivery?.end,raw.pricingPolicy.fxJpyToVnd,raw.pricingPolicy.serviceFeePercent]);
  // Only images expressly allowed by the trusted backend display gate reach public UI,
  // including the cart and checkout. The legacy quote image is not permission evidence.
  const display = parseDisplay(raw.display, raw.asin, raw.sourceUrl);
  const allowedImage = display?.images?.[0] ?? null;
  return { quoteId: raw.id, asin: raw.asin, name: raw.title, seller: raw.seller,
    variant: raw.variant, offerId: raw.offerId,
    shippingEvidence: raw.shippingEvidence, shippingType: 'standard',
    sourceUrl: raw.sourceUrl, imageUrl: allowedImage, display, quantity: raw.quantity,
    priceJpy: raw.priceJpy, priceVnd: raw.unitPriceVnd,
    observedAt: raw.observedAt, expiresAt: raw.expiresAt,
    amazonDeliveryDate: raw.amazonDelivery?.start || null, amazonDeliveryEnd: raw.amazonDelivery?.end || null,
    vietnamDeliveryDate: raw.vietnamDelivery?.start || null, vietnamDeliveryEnd: raw.vietnamDelivery?.end || null,
    deliveryBufferDays: raw.deliveryDays, freeShipping: raw.freeJapanShipping, canOrder: true,
    warning: !raw.amazonDelivery ? "Chưa xác định ngày giao Amazon. Bạn vẫn có thể gửi đơn nếu xác nhận thông tin." : null,
    fingerprint };
}

export function parseAmazonQuote(raw: unknown): AmazonQuote {
  const range = (value: unknown) => value === null || (record(value) &&
    [value.start, value.end].every(v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) &&
      Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v) && String(value.start) <= String(value.end));
  if (!record(raw) || !text(raw.id, 100) || typeof raw.asin !== "string" || !/^[A-Z0-9]{10}$/.test(raw.asin) ||
      raw.sourceUrl !== `https://www.amazon.co.jp/dp/${raw.asin}` ||
      !text(raw.title, 1000) || !text(raw.seller, 1000) || !text(raw.variant, 2000) || !text(raw.offerId, 2048) ||
      !text(raw.shippingEvidence, 4000) || raw.freeJapanShipping !== true || raw.purchaseType !== "one_time" || raw.shippingType !== "standard" ||
      !Number.isInteger(raw.quantity) || Number(raw.quantity) < 1 || Number(raw.quantity) > 99 ||
      !Number.isSafeInteger(raw.priceJpy) || Number(raw.priceJpy) <= 0 ||
      !Number.isSafeInteger(raw.unitPriceVnd) || Number(raw.unitPriceVnd) <= 0 ||
      !Number.isSafeInteger(Number(raw.priceJpy) * Number(raw.quantity)) ||
      !Number.isSafeInteger(Number(raw.unitPriceVnd) * Number(raw.quantity)) ||
      !timestamp(raw.observedAt) || !timestamp(raw.expiresAt) || Date.parse(raw.expiresAt) <= Date.parse(raw.observedAt) ||
      !Number.isInteger(raw.deliveryDays) || Number(raw.deliveryDays) < 0 || Number(raw.deliveryDays) > 90 ||
      !range(raw.amazonDelivery) || !range(raw.vietnamDelivery) || (raw.amazonDelivery === null && raw.vietnamDelivery !== null) ||
      !record(raw.pricingPolicy) || typeof raw.pricingPolicy.fxJpyToVnd !== "number" ||
      !Number.isFinite(raw.pricingPolicy.fxJpyToVnd) || raw.pricingPolicy.fxJpyToVnd <= 0 ||
      typeof raw.pricingPolicy.serviceFeePercent !== "number" || !Number.isFinite(raw.pricingPolicy.serviceFeePercent) || raw.pricingPolicy.serviceFeePercent < 0) {
    throw new Error('Báo giá từ máy chủ không hợp lệ.');
  }
  return projectQuote(raw as unknown as ServerQuote);
}

const messages: Record<string,string> = {
  amazon_quotes_disabled: "Hệ thống tra giá Amazon đang chờ xác minh nguồn. Hiện chưa nhận đơn mua hộ trực tuyến.",
  invalid_amazon_input: "Hãy nhập mã ASIN 10 ký tự hoặc link sản phẩm Amazon.co.jp hợp lệ.",
  offer_not_verified: "Đã nhận thông tin từ Amazon. Báo giá đặt mua tại Mita chưa sẵn sàng.",
  amazon_cooldown: "Mita đang tạm dừng truy cập nguồn Amazon sau lần bị từ chối trước đó. Vui lòng thử lại sau.",
  amazon_busy: "Hệ thống đang kiểm tra Amazon. Vui lòng thử lại sau.",
  amazon_rate_limited: "Amazon đang giới hạn truy cập. Mita tạm dừng tra thông tin từ nguồn.",
  amazon_blocked: "Amazon yêu cầu xác minh truy cập, không thể báo giá tự động.",
  quote_rate_limited: "Có quá nhiều yêu cầu tra giá. Vui lòng thử lại sau một phút.",
  quote_schema_unavailable: "Hệ thống báo giá chưa được cấu hình. Vui lòng thử lại sau.",
  quote_unavailable: "Máy chủ báo giá chưa thể xử lý yêu cầu. Vui lòng thử lại sau.",
  amazon_unavailable: "Chưa thể lấy thông tin sản phẩm từ Amazon. Vui lòng thử lại sau.",
  quote_service_unavailable: "Không kết nối được máy chủ báo giá. Vui lòng thử lại."
};

export class AmazonQuoteApiError extends Error {
  constructor(message: string, public readonly code: string | null = null,
    public readonly preview: AmazonSourcePreview | null = null,
    public readonly retryAfterAt: string | null = null) { super(message); }
}

function parseSourcePreview(value: unknown): AmazonSourcePreview | null {
  if (!record(value)) return null;
  const raw = value;
  if (typeof raw.asin !== "string" || !/^[A-Z0-9]{10}$/.test(raw.asin) ||
      raw.sourceUrl !== `https://www.amazon.co.jp/dp/${raw.asin}` ||
      typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > 1000 ||
      !timestamp(raw.observedAt)) return null;
  const display = parseDisplay(raw.display, raw.asin, raw.sourceUrl);
  const observedDetails = parseObservedDetails(raw.observedDetails);
  const deliveryText = text(raw.deliveryText, 400) ? raw.deliveryText.trim() : undefined;
  return { asin: raw.asin, title: raw.title.trim(), sourceUrl: raw.sourceUrl, observedAt: raw.observedAt,
    ...(Number.isSafeInteger(raw.priceJpy) && Number(raw.priceJpy) > 0 && Number(raw.priceJpy) <= 100000000 ? { priceJpy: Number(raw.priceJpy) } : {}),
    ...(observedDetails ? { observedDetails } : {}),
    ...(deliveryText ? { deliveryText } : {}),
    ...(deliveryText && raw.freeDelivery === true ? { freeDelivery: true as const } : {}),
    ...(display?.provenance.observedAt === raw.observedAt ? { display } : {}) };
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store" });
  } catch {
    throw new AmazonQuoteApiError(messages.quote_service_unavailable, "quote_service_unavailable");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string; code?: string; retryAfterAt?: unknown; details?: { preview?: unknown; retryAfterAt?: unknown } } | null;
    const code = typeof body?.code === "string" ? body.code : [502, 503, 504].includes(response.status) ? "quote_service_unavailable" : null;
    const message = (code && messages[code]) || (typeof body?.error === "string" && body.error) || "Không thể tra giá Amazon lúc này. Vui lòng thử lại.";
    throw new AmazonQuoteApiError(message, code,
      code === "offer_not_verified" ? parseSourcePreview(body?.details?.preview) : null,
      timestamp(body?.details?.retryAfterAt ?? body?.retryAfterAt) ? String(body?.details?.retryAfterAt ?? body?.retryAfterAt) : null);
  }
  return response.json() as Promise<T>;
}

const jsonHeaders = { "Content-Type": "application/json" };
export function createAmazonQuote(input: string, quantity: number): Promise<AmazonQuote> {
  const asin = amazonInputAsin(input);
  if (!asin) return Promise.reject(new AmazonQuoteApiError(messages.invalid_amazon_input, "invalid_amazon_input"));
  return api<{quote:ServerQuote}>("/api/amazon/quotes", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ input: asin, quantity }) }).then(data => {
    const quote = parseAmazonQuote(data.quote);
    if (quote.asin !== asin || quote.quantity !== quantity) throw new Error("Báo giá không khớp sản phẩm hoặc số lượng yêu cầu.");
    return quote;
  });
}
export function refreshAmazonQuote(id: string, quantity: number): Promise<AmazonQuote> {
  void quantity; // Server snapshot governs quantity; client may not override it.
  return api<{quote:ServerQuote}>(`/api/amazon/quotes/${encodeURIComponent(id)}/refresh`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({})
  }).then(data=>parseAmazonQuote(data.quote));
}
