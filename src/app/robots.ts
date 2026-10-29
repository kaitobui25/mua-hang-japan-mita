import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/server-catalog";

export default function robots(): MetadataRoute.Robots {
  return {
    // Admin pages remain crawlable so their existing noindex metadata is read.
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
