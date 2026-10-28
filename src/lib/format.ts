import type { CatalogProduct } from "@/types/catalog";

export const CATEGORIES = [
  { slug: "thuc-pham-bo-sung", name: "Thực phẩm bổ sung", description: "Chăm sóc sức khỏe theo thói quen của bạn", short: "Sức khỏe" },
  { slug: "thuc-pham-cho-be", name: "Thực phẩm cho bé", description: "Mỗi bữa ăn nhỏ, thêm nhiều yêu thương", short: "Cho bé" },
] as const;

export const formatVnd = (value: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value);

export function formatObservation(value?: string | null) {
  if (!value || Number.isNaN(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(value));
}

export function isFreshPrice(product: CatalogProduct) {
  const observed = Date.parse(product.priceObservedAt || "");
  return typeof product.priceVnd === "number" && Number.isFinite(product.priceVnd) && product.priceVnd > 0
    && Number.isFinite(observed) && observed <= Date.now() && Date.now() - observed <= 24 * 60 * 60 * 1000;
}

export function canCheckout(product: CatalogProduct) {
  return isFreshPrice(product)
    && product.status === "ready"
    && product.availability !== "out_of_stock"
    && product.availability !== "requires_verification";
}

export function productStatus(product: CatalogProduct) {
  if (product.availability === "out_of_stock") return "Tạm hết hàng";
  if (product.availability === "requires_verification") return "Liên hệ để kiểm tra";
  if (!product.priceVnd) return "Giá đang cập nhật";
  if (!isFreshPrice(product)) return "Giá đang cập nhật";
  return "";
}

export function categoryName(slug: string) {
  return CATEGORIES.find(category => category.slug === slug)?.name || "Sản phẩm Nhật";
}

export function validAmazonUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "amazon.co.jp" || url.hostname === "www.amazon.co.jp")
      && /^\/(?:dp|gp\/product)\/[A-Z0-9]{10}(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}
