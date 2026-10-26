import type { CatalogProduct, CatalogResponse, CartItem, CheckoutResponse, Customer } from "@/types/catalog";

type CatalogParams = { category?: string; q?: string; page?: number; limit?: number; sort?: string };

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
      const error = await response.json() as { error?: string; message?: string };
      message = error.message || error.error;
    } catch { /* The server may return plain text or an empty response. */ }
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

export async function submitCheckout(items: CartItem[], customer: Customer): Promise<CheckoutResponse> {
  const data = await request<CheckoutResponse>("/api/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items, customer }),
  });
  if (!data || data.status !== "simulation_created" || !data.orderId) {
    throw new Error("Máy chủ chưa xác nhận đơn mô phỏng. Vui lòng thử lại.");
  }
  return data;
}
