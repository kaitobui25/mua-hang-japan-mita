import type { CatalogProduct } from "@/types/catalog";
import { canCheckout } from "@/lib/format";

/** Preserve the requested option if purchasable; otherwise prefer a sibling of the same size. */
export function preferredVariantAsin(product: CatalogProduct): string {
  if (canCheckout(product)) return product.asin;
  const attributes = Object.entries(product.variantAttributes ?? {});
  const score = (variant: CatalogProduct) => attributes.reduce((sum, [key, value]) => {
    if (variant.variantAttributes?.[key] !== value) return sum;
    return sum + (/size|weight|kích|容量|量/i.test(key) ? 5 : 1);
  }, 0);
  const candidates = (product.variants ?? []).filter(canCheckout);
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0]?.asin ?? product.asin;
}
