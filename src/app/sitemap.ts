import type { MetadataRoute } from "next";
import { CATEGORIES } from "@/lib/format";
import { getServerPublicAsins, SITE_URL } from "@/lib/server-catalog";

export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const paths = new Set([
    "/", "/san-pham", "/danh-gia", "/cach-mua-hang", "/gio-hang", "/thanh-toan", "/mua-ho-amazon",
    ...CATEGORIES.map(category => `/danh-muc/${category.slug}`),
  ]);
  const asins = await getServerPublicAsins();
  for (const asin of asins) paths.add(`/san-pham/${asin}`);
  if (paths.size > 50_000) throw new Error("Sitemap requires splitting before exceeding 50,000 URLs");
  return [...paths].map(path => ({ url: `${SITE_URL}${path}` }));
}
