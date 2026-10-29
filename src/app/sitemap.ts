import type { MetadataRoute } from "next";
import { CATEGORIES } from "@/lib/format";
import { getServerCatalog, getServerProduct, SITE_URL } from "@/lib/server-catalog";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const paths = new Set([
    "/", "/san-pham", "/danh-gia", "/cach-mua-hang", "/gio-hang", "/thanh-toan",
    ...CATEGORIES.map(category => `/danh-muc/${category.slug}`),
  ]);
  // The public list groups variants. Expand each group through the public detail
  // endpoint so every public ASIN is discoverable without changing visibility rules.
  const first = await getServerCatalog(1);
  const pages = Math.max(1, Math.ceil(first.total / 100));
  for (let page = 1; page <= pages; page++) {
    const catalog = page === 1 ? first : await getServerCatalog(page);
    if (!catalog.items.length && catalog.total > 0) throw new Error("Incomplete sitemap catalog page");
    for (let offset = 0; offset < catalog.items.length; offset += 8) {
      const products = await Promise.all(catalog.items.slice(offset, offset + 8).map(item => getServerProduct(item.asin)));
      for (const product of products) {
        if (!product) throw new Error("Catalog changed during sitemap generation; retry the request");
        for (const item of [product, ...(product.variants ?? [])]) {
          if (!/^[A-Z0-9]{10}$/.test(item.asin)) throw new Error("Invalid sitemap ASIN");
          paths.add(`/san-pham/${item.asin}`);
        }
      }
    }
  }
  if (paths.size > 50_000) throw new Error("Sitemap requires splitting before exceeding 50,000 URLs");
  return [...paths].map(path => ({ url: `${SITE_URL}${path}` }));
}
