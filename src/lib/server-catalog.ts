import "server-only";
import { cache } from "react";
import type { CatalogProduct, CatalogResponse } from "@/types/catalog";

export const SITE_URL = "https://mitajapanshop.duckdns.org";

export async function getServerPublicAsins(): Promise<string[]> {
  const response = await request('/api/catalog/asins');
  if (!response.ok) throw new Error(`Public ASIN API returned HTTP ${response.status}`);
  const inventory: unknown = await response.json();
  if (!inventory || typeof inventory !== 'object' || !('asins' in inventory) || !('total' in inventory)) {
    throw new Error('Invalid public ASIN inventory');
  }
  const { asins, total } = inventory;
  if (!Array.isArray(asins) || !Number.isSafeInteger(total) || total !== asins.length ||
      asins.length === 0 || asins.length > 50_000 ||
      asins.some(asin => typeof asin !== 'string' || asin.length !== 10 || !/^[A-Z0-9]{10}$/.test(asin)) ||
      new Set(asins).size !== asins.length) {
    throw new Error('Invalid or incomplete public ASIN inventory');
  }
  return asins;
}

async function request(path: string): Promise<Response> {
  try {
    return await fetch(`http://127.0.0.1:${process.env.API_PORT ?? "4000"}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    throw new Error("Không thể kết nối máy chủ sản phẩm. Vui lòng thử lại sau.", { cause });
  }
}

export const getServerProduct = cache(async (asin: string): Promise<CatalogProduct | null> => {
  if (!/^[A-Z0-9]{10}$/.test(asin)) return null;
  const response = await request(`/api/catalog/products/${encodeURIComponent(asin)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Product API returned HTTP ${response.status}`);
  const product = await response.json() as CatalogProduct;
  if (product?.asin !== asin || typeof product.name !== "string" || !product.name.trim()) {
    throw new Error("Invalid product API response");
  }
  return product;
});

export function catalogSearchParams(params: Record<string, string | string[] | undefined>) {
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const rawPage = Number(first(params.page) || 1);
  return {
    q: first(params.q) || "",
    sort: first(params.sort) || "reviews",
    page: Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1,
  };
}

export async function getServerCatalog(params: number | {
  category?: string; q?: string; sort?: string; limit?: number; page?: number;
}): Promise<CatalogResponse> {
  // Preserve the numeric caller's existing 100-item, name-sorted pagination.
  const options = typeof params === "number" ? { page: params, limit: 100, sort: "name" } : params;
  const query = new URLSearchParams({
    page: String(options.page ?? 1), limit: String(options.limit ?? 12), sort: options.sort || "reviews",
  });
  if (options.category) query.set("category", options.category);
  if (options.q?.trim()) query.set("q", options.q.trim());
  const response = await request(`/api/catalog?${query}`);
  if (!response.ok) throw new Error(`Catalog API returned HTTP ${response.status}`);
  const catalog = await response.json() as CatalogResponse;
  if (!Array.isArray(catalog?.items) || !Number.isSafeInteger(catalog.total) || catalog.total < 0) {
    throw new Error("Invalid catalog API response");
  }
  return catalog;
}
