/** Legacy catalog preview helper, not used by the Amazon purchase-assistance page. */
import { amazonInputAsin } from "./amazon-input";
export { amazonInputAsin } from "./amazon-input";
export type AmazonCachedPreview = {
  asin: string;
  sourceUrl: string;
  title?: string;
  updatedAt?: string;
};

export function publicCatalogPreview(raw: unknown, asin: string): AmazonCachedPreview | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const sourceUrl = `https://www.amazon.co.jp/dp/${asin}`;
  if (data.asin !== asin || data.sourceUrl !== sourceUrl || typeof data.name !== "string" ||
      !data.name.trim() || data.name.length > 1000) return null;
  const updatedAt = typeof data.lastUpdatedAt === "string" && Number.isFinite(Date.parse(data.lastUpdatedAt))
    ? data.lastUpdatedAt : undefined;
  return { asin, sourceUrl, title: data.name.trim(), ...(updatedAt ? { updatedAt } : {}) };
}

/** Returns at least a canonical link for valid input, even if the local catalog has no match. */
export async function lookupLocalAmazonPreview(input: string): Promise<AmazonCachedPreview | null> {
  const asin = amazonInputAsin(input);
  if (!asin) return null;
  const fallback: AmazonCachedPreview = { asin, sourceUrl: `https://www.amazon.co.jp/dp/${asin}` };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const lookup = (async () => {
      const response = await fetch(`/api/catalog/products/${asin}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) return fallback;
      return publicCatalogPreview(await response.json(), asin) ?? fallback;
    })();
    // Bound the entire lookup, including JSON body parsing and non-cooperative proxy responses.
    const timeout = new Promise<AmazonCachedPreview>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(fallback); }, 4000);
    });
    return await Promise.race([lookup, timeout]);
  } catch { return fallback; }
  finally { if (timer) clearTimeout(timer); }
}
