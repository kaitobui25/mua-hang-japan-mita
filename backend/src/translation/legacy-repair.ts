import type { PoolClient } from 'pg';
import { usableTranslation } from './warnings.js';

export const legacyNameManifest = {
  B0DDXYC8NL: 'product_codes_changed', B0FSL4CP1M: 'product_codes_changed',
  B0H1GZLGK9: 'numbers_changed', B0H5C5GHMP: 'numbers_changed',
  B0H5C6PKR1: 'numbers_changed', B0G5XT3VHX: null
} as const;
export type LegacyNameReview = {
  asin: keyof typeof legacyNameManifest;
  source_hash: string; name: string | null; status: 'failed'; name_attempts: number;
  name_source: { name: string; brand: string | null } | null; name_issues: string[];
  /** Reviewed current product source; freezes legacy rows whose name_source is NULL. */
  source: { name: string; brand: string | null };
  /** Only the missing-candidate ASIN may receive ONE explicitly reviewed retry. */
  grantMissingRetry?: true;
};

/** Review with apply=false first. Exact compare-and-swap, one-ASIN transaction,
 * durable receipt, and no provider calls. Never infer a candidate or its source.
 * Requires a dedicated connection and the original reviewed snapshot on replay. */
export async function repairLegacyName(connection: Pick<PoolClient, 'query'>,
  review: LegacyNameReview, apply = false): Promise<'preview' | 'repaired' | 'already_repaired'> {
  if (!Object.hasOwn(legacyNameManifest, review.asin) || review.status !== 'failed' ||
      !review.source_hash || !review.source?.name || !Array.isArray(review.name_issues) ||
      !Number.isInteger(review.name_attempts) ||
      review.name_attempts < 0 || review.name_attempts > 3) throw new Error('invalid_repair_review');
  const issue = legacyNameManifest[review.asin];
  if (issue) {
    usableTranslation(review.name, 600);
    if (!review.name_issues.includes(issue) || review.grantMissingRetry) throw new Error('invalid_repair_review');
  } else if (review.name !== null || (review.name_attempts >= 3 && !review.grantMissingRetry)) {
    throw new Error('missing_retry_budget');
  }
  const before = { source_hash: review.source_hash, name: review.name, status: review.status,
    name_attempts: review.name_attempts, name_source: review.name_source, name_issues: review.name_issues,
    source: review.source };
  const after = { ...before, status: issue ? 'warning' : 'pending',
    name_source: review.name_source ?? review.source,
    name_attempts: !issue && review.grantMissingRetry ? Math.min(2, review.name_attempts) : review.name_attempts };
  await connection.query('BEGIN');
  try {
    const receipt = await connection.query(`SELECT asin FROM translation_name_repairs
      WHERE asin=$1 AND before_value=$2::jsonb AND after_value=$3::jsonb`,
    [review.asin, JSON.stringify(before), JSON.stringify(after)]);
    if (receipt.rows.length) {
      await connection.query('ROLLBACK'); return 'already_repaired';
    }
    const current = await connection.query(`SELECT t.asin FROM product_translations t JOIN products p ON p.asin=t.asin
      WHERE t.asin=$1 AND t.locale='vi' AND t.source_hash=$2 AND t.name IS NOT DISTINCT FROM $3
        AND t.status=$4 AND t.name_attempts=$5 AND t.name_source IS NOT DISTINCT FROM $6::jsonb
        AND t.name_issues=$7::jsonb AND p.name=$8 AND p.brand IS NOT DISTINCT FROM $9
      FOR UPDATE OF p,t`, [review.asin, before.source_hash, before.name, before.status,
      before.name_attempts, before.name_source === null ? null : JSON.stringify(before.name_source),
      JSON.stringify(before.name_issues), review.source.name, review.source.brand]);
    if (!current.rows.length) throw new Error('repair_precondition_changed');
    if (!apply) { await connection.query('ROLLBACK'); return 'preview'; }
    await connection.query(`UPDATE product_translations SET status=$2,name_attempts=$3,name_source=$4,updated_at=now()
      WHERE asin=$1 AND locale='vi'`, [review.asin, after.status, after.name_attempts, JSON.stringify(after.name_source)]);
    await connection.query(`INSERT INTO translation_name_repairs(asin,before_value,after_value)
      VALUES($1,$2,$3)`, [review.asin, JSON.stringify(before), JSON.stringify(after)]);
    await connection.query('COMMIT'); return 'repaired';
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
}
