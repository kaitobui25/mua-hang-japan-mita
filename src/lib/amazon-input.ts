/** Normalize only explicitly supported Amazon Japan product links and ASINs. */
export function amazonInputAsin(input: string): string | null {
  const value = input.trim();
  if (value.length > 2048) return null;
  if (/^[a-z0-9]{10}$/i.test(value)) return value.toUpperCase();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["amazon.co.jp", "www.amazon.co.jp"].includes(url.hostname) ||
        url.port || url.username || url.password) return null;
    return url.pathname.match(/\/(?:dp|gp\/(?:product|aw\/d))\/([a-z0-9]{10})(?:\/|$)/i)?.[1].toUpperCase() ?? null;
  } catch { return null; }
}
