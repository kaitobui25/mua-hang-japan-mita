import type { PoolClient } from 'pg';
import { usableTranslation } from './warnings.js';

type ProductTitle = { asin: string; name: string; titleExtras?: string[] };
type StoredTitle = {
  asin: string; short_name: string; omitted_facts: string[];
  translated_name: string;
};

/** Optional projection; a missing or stale title never replaces a usable name. */
export async function applyTitlePresentations<T extends ProductTitle>(
  products: T[], connection: Pick<PoolClient, 'query'>
): Promise<void> {
  if (!products.length) return;
  const { rows } = await connection.query<StoredTitle>(`SELECT pt.asin,pt.short_name,
      pt.omitted_facts,pt.translated_name
    FROM product_title_presentations pt
    JOIN products p ON p.asin=pt.asin AND p.name=pt.source_name
    JOIN product_translations t ON t.asin=pt.asin AND t.locale='vi'
      AND t.name=pt.translated_name AND t.status IN ('success','warning')
    WHERE pt.asin=ANY($1::varchar(10)[])`, [products.map(product => product.asin)]);
  const titles = new Map(rows.map(row => [row.asin, row]));
  for (const product of products) {
    const title = titles.get(product.asin);
    if (!title) continue;
    try {
      const shortName = usableTranslation(title.short_name, 120);
      const omitted = title.omitted_facts.map(fact => usableTranslation(fact, 500));
      // The unabridged accepted translation stays readable and searchable.
      const extra = [...new Set([...omitted, title.translated_name])]
        .filter(text => text !== shortName);
      product.name = shortName;
      product.titleExtras = extra;
    } catch {
      // Older invalid rows must fall back to the original presentation.
    }
  }
}
