import type { AmazonQuote } from "@/types/amazon-quote";

type DateRange = { start: string; end: string } | null;
type ServerQuote = {
  id: string; asin: string; title: string; seller: string; sourceUrl: string; imageUrl: string | null;
  quantity: number; priceJpy: number; unitPriceVnd: number; observedAt: string; expiresAt: string;
  deliveryDays: number; amazonDelivery: DateRange; vietnamDelivery: DateRange;
  freeJapanShipping: true; shippingEvidence: string; variant: string; offerId: string;
  purchaseType: string; shippingType: string; pricingPolicy: { fxJpyToVnd: number; serviceFeePercent: number };
};

function projectQuote(raw: ServerQuote): AmazonQuote {
  // The comparison key represents offer and displayed terms, not the issued quote id/time.
  const fingerprint = JSON.stringify([raw.asin,raw.sourceUrl,raw.title,raw.variant,raw.seller,raw.offerId,raw.quantity,
    raw.priceJpy,raw.unitPriceVnd,raw.imageUrl,raw.purchaseType,raw.shippingType,raw.freeJapanShipping,
    raw.shippingEvidence,raw.amazonDelivery?.start,raw.amazonDelivery?.end,raw.deliveryDays,
    raw.vietnamDelivery?.start,raw.vietnamDelivery?.end,raw.pricingPolicy.fxJpyToVnd,raw.pricingPolicy.serviceFeePercent]);
  return { quoteId: raw.id, asin: raw.asin, name: raw.title, seller: raw.seller,
    variant: raw.variant, offerId: raw.offerId,
    shippingEvidence: raw.shippingEvidence, shippingType: 'standard',
    sourceUrl: raw.sourceUrl, imageUrl: raw.imageUrl, quantity: raw.quantity,
    priceJpy: raw.priceJpy, priceVnd: raw.unitPriceVnd,
    observedAt: raw.observedAt, expiresAt: raw.expiresAt,
    amazonDeliveryDate: raw.amazonDelivery?.start || null, amazonDeliveryEnd: raw.amazonDelivery?.end || null,
    vietnamDeliveryDate: raw.vietnamDelivery?.start || null, vietnamDeliveryEnd: raw.vietnamDelivery?.end || null,
    deliveryBufferDays: raw.deliveryDays, freeShipping: raw.freeJapanShipping, canOrder: true,
    warning: !raw.amazonDelivery ? "Chưa xác định ngày giao Amazon. Bạn vẫn có thể gửi đơn nếu xác nhận thông tin." : null,
    fingerprint };
}

export function parseAmazonQuote(raw: unknown): AmazonQuote {
  if (!raw || typeof raw !== 'object' ||
      !('id' in raw) || typeof raw.id !== 'string' ||
      !('pricingPolicy' in raw) || !raw.pricingPolicy ||
      !('priceJpy' in raw) || !Number.isSafeInteger(raw.priceJpy) ||
      !('unitPriceVnd' in raw) || !Number.isSafeInteger(raw.unitPriceVnd)) {
    throw new Error('Báo giá từ máy chủ không hợp lệ.');
  }
  return projectQuote(raw as ServerQuote);
}

const messages: Record<string,string> = {
  amazon_quotes_disabled: "Hệ thống tra giá Amazon đang chờ xác minh nguồn. Hiện chưa nhận đơn mua hộ trực tuyến.",
  invalid_amazon_input: "Hãy nhập mã ASIN 10 ký tự hoặc link sản phẩm Amazon.co.jp hợp lệ.",
  offer_not_verified: "Không xác minh được giá và miễn phí giao thường tại Nhật cho sản phẩm này.",
  amazon_cooldown: "Amazon đang hạn chế truy cập. Vui lòng thử lại sau.",
  amazon_busy: "Hệ thống đang kiểm tra Amazon. Vui lòng thử lại sau.",
  amazon_blocked: "Amazon yêu cầu xác minh truy cập, không thể báo giá tự động.",
  quote_rate_limited: "Có quá nhiều yêu cầu tra giá. Vui lòng thử lại sau một phút.",
  quote_schema_unavailable: "Hệ thống báo giá chưa được cấu hình. Vui lòng thử lại sau."
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store" });
  } catch {
    throw new Error("Không kết nối được máy chủ báo giá. Vui lòng thử lại.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; code?: string };
    throw new Error((body.code && messages[body.code]) || body.error || "Không thể tra giá Amazon lúc này. Vui lòng thử lại.");
  }
  return response.json() as Promise<T>;
}

const jsonHeaders = { "Content-Type": "application/json" };
export function createAmazonQuote(input: string, quantity: number): Promise<AmazonQuote> {
  return api<{quote:ServerQuote}>("/api/amazon/quotes", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ input, quantity }) }).then(data=>parseAmazonQuote(data.quote));
}
export function refreshAmazonQuote(id: string, quantity: number): Promise<AmazonQuote> {
  void quantity; // Server snapshot governs quantity; client may not override it.
  return api<{quote:ServerQuote}>(`/api/amazon/quotes/${encodeURIComponent(id)}/refresh`, {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({})
  }).then(data=>parseAmazonQuote(data.quote));
}
