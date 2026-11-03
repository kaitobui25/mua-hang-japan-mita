import type { CatalogProduct, CatalogResponse, CartItem, CheckoutResponse, Customer } from "@/types/catalog";

type CatalogParams = { category?: string; q?: string; page?: number; limit?: number; sort?: string };

export class CheckoutApiError extends Error {
  constructor(message: string, public code: string, public details?: unknown) { super(message); }
}

const checkoutErrorMessages: Record<string, string> = {
  quote_refresh_required: "Báo giá Amazon đã hết hạn. Cần xác nhận báo giá mới trước khi đặt hàng.",
  quote_expired: "Báo giá Amazon đã hết hạn. Hãy tra lại giá.",
  quote_already_ordered: "Báo giá này đã được sử dụng. Hãy kiểm tra đơn hàng trước khi thử lại.",
  checkout_key_conflict: "Nội dung giỏ hàng đã thay đổi trong khi gửi đơn. Vui lòng kiểm tra lại.",
  missing_eta_acknowledgement: "Cần xác nhận rằng ngày giao Amazon chưa xác định.",
  duplicate_asin: "Một ASIN đang có nhiều báo giá/nguồn hàng. Vui lòng tách thành các đơn khác nhau."
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new Error("Không thể kết nối máy chủ. Vui lòng kiểm tra kết nối và thử lại.");
  }
  if (!response.ok) {
    let message: string | undefined;
    try {
      const error = await response.json() as { error?: string; message?: string; code?: string; details?: unknown };
      if (error.code && path === '/api/checkout') {
        throw new CheckoutApiError(checkoutErrorMessages[error.code] || error.message || error.error || `Lỗi đặt hàng (${error.code}).`, error.code, error.details);
      }
      message = error.message || error.error;
    } catch (cause) { if (cause instanceof CheckoutApiError) throw cause; /* The server may return plain text or an empty response. */ }
    throw new Error(message || `Yêu cầu không thành công (HTTP ${response.status}). Vui lòng thử lại.`);
  }
  return response.json() as Promise<T>;
}

export async function fetchCatalog(params: CatalogParams = {}): Promise<CatalogResponse> {
  const query = new URLSearchParams();
  if (params.category) query.set("category", params.category);
  if (params.q?.trim()) query.set("q", params.q.trim());
  query.set("page", String(params.page || 1));
  query.set("limit", String(params.limit || 12));
  if (params.sort) query.set("sort", params.sort);
  const data = await request<CatalogResponse>(`/api/catalog?${query.toString()}`);
  if (!data || !Array.isArray(data.items) || !Number.isFinite(data.total)) {
    throw new Error("Dữ liệu sản phẩm chưa hợp lệ. Vui lòng thử lại sau.");
  }
  return data;
}

export async function fetchProduct(asin: string): Promise<CatalogProduct> {
  const data = await request<CatalogProduct>(`/api/catalog/products/${encodeURIComponent(asin)}`);
  if (!data || !data.asin) throw new Error("Không tìm thấy thông tin sản phẩm.");
  return data;
}

export async function submitCheckout(items: CartItem[], customer: Customer, requestId?: string): Promise<CheckoutResponse> {
  const data = await request<CheckoutResponse>("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkoutKey:requestId, items: items.filter(item=>item.kind !== "amazon_quote").map(item=>({ asin: item.asin, quantity: item.quantity })),
      quoteItems: items.filter(item=>item.kind === "amazon_quote" && item.quote).map(item=>({ quoteId: item.quote!.quoteId,
        confirmed: true, acknowledgeMissingEta: !item.quote!.amazonDeliveryDate ? true : undefined })), customer }),
  });
  if (!data || !['pending_confirmation','already_submitted'].includes(data.status) || !data.orderId) {
    throw new Error("Máy chủ chưa ghi nhận đơn hàng. Vui lòng thử lại.");
  }
  return data;
}
