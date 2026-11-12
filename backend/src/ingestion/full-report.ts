// Counts persisted changes, not merely fields observed again during an Amazon full scan.
export type FullProductSnapshot = {
  asin: string;
  name: string;
  price_jpy: number | null;
  image_urls: string[];
};

export type FullCategoryCounts = {
  newProducts: number;
  existingProducts: number;
  nameChanged: number;
  priceChanged: number;
  imagesChanged: number;
};

export type FullCategoryBreakdown = Record<string, FullCategoryCounts>;

export function emptyFullCategoryCounts(): FullCategoryCounts {
  return { newProducts: 0, existingProducts: 0, nameChanged: 0, priceChanged: 0, imagesChanged: 0 };
}

export function countFullSavedProduct(
  breakdown: FullCategoryBreakdown,
  category: string,
  before: FullProductSnapshot | undefined,
  after: FullProductSnapshot
): void {
  const counts = breakdown[category] ??= emptyFullCategoryCounts();
  if (!before) {
    counts.newProducts++;
    return;
  }
  counts.existingProducts++;
  if (before.name !== after.name) counts.nameChanged++;
  if (before.price_jpy !== after.price_jpy) counts.priceChanged++;
  // Compare the actual persisted, ordered gallery, not the untrusted Amazon candidates.
  if (before.image_urls.length !== after.image_urls.length ||
      before.image_urls.some((url, index) => url !== after.image_urls[index])) counts.imagesChanged++;
}
