import { open, stat } from 'node:fs/promises';
import { db } from '../db/pool.js';
import { warningLogPath } from '../translation/warnings.js';

const maxTailBytes = 1024 * 1024;
const asinPattern = /^[A-Z0-9]{10}$/;

export async function recentAdminIssues(asin?: string) {
  if (asin && !asinPattern.test(asin)) throw new Error('invalid_asin');
  const amazon = await db.query(
    'SELECT id,sync_run_id,category_slug,asin,state,message,created_at FROM sync_errors ' +
    'WHERE ($1::varchar(10) IS NULL OR asin=$1) ORDER BY id DESC LIMIT 100', [asin ?? null]);
  // Current persisted state, not event history. Select only warning metadata.
  const persisted = await db.query(`
    SELECT asin,field,status,issues,updated_at FROM (
      (SELECT asin,'name'::text AS field,status,
        name_issues AS issues,updated_at
       FROM product_translations
       WHERE locale='vi' AND ($1::varchar(10) IS NULL OR asin=$1)
         AND (status='warning' OR CASE WHEN jsonb_typeof(name_issues)='array'
           THEN jsonb_array_length(name_issues)>0 ELSE false END)
       ORDER BY updated_at DESC,asin LIMIT 100)
      UNION ALL
      (SELECT asin,left(slot,100) AS field,'warning'::text AS status,issues,updated_at
       FROM local_detail_translation_items
       WHERE ($1::varchar(10) IS NULL OR asin=$1)
         AND (warning OR CASE WHEN jsonb_typeof(issues)='array'
           THEN jsonb_array_length(issues)>0 ELSE false END)
       ORDER BY updated_at DESC,asin,slot LIMIT 100)
    ) warnings ORDER BY updated_at DESC,asin,field LIMIT 100`, [asin ?? null]);
  const persistedTranslations = persisted.rows.slice(0, 100).flatMap(row => {
    if (typeof row.asin !== 'string' || !asinPattern.test(row.asin) || (asin && row.asin !== asin)) return [];
    return [{
      asin: row.asin,
      field: typeof row.field === 'string' ? row.field.slice(0, 100) : 'unknown',
      status: typeof row.status === 'string' ? row.status.slice(0, 100) : 'warning',
      issues: Array.isArray(row.issues)
        ? row.issues.filter((entry: unknown): entry is string => typeof entry === 'string').slice(0, 20).map((entry: string) => entry.slice(0, 100))
        : [],
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString()
        : typeof row.updated_at === 'string' ? row.updated_at.slice(0, 100) : null
    }];
  });
  const translations: Record<string, unknown>[] = [];
  let logAvailable = false;
  try {
    const fileSize = (await stat(warningLogPath)).size;
    const start = Math.max(0, fileSize - maxTailBytes);
    const file = await open(warningLogPath, 'r');
    try {
      const bytes = Buffer.alloc(fileSize - start);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
      const lines = bytes.subarray(0, bytesRead).toString('utf8').split('\n');
      if (start > 0) lines.shift();
      for (const line of lines.reverse()) {
        if (!line.trim() || translations.length >= 100) continue;
        try {
          const value: unknown = JSON.parse(line);
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          const issue = value as Record<string, unknown>;
          if (typeof issue.asin !== 'string' || !asinPattern.test(issue.asin)) continue;
          if (asin && issue.asin !== asin) continue;
          if (issue.result !== 'failed' && issue.result !== 'warning') continue;
          translations.push({
            timestamp: typeof issue.timestamp === 'string' ? issue.timestamp.slice(0, 100) : null,
            asin: issue.asin,
            field: typeof issue.field === 'string' ? issue.field.slice(0, 100) : 'unknown',
            engine: typeof issue.engine === 'string' ? issue.engine.slice(0, 100) : null,
            model: typeof issue.model === 'string' ? issue.model.slice(0, 100) : null,
            attempt: Number.isSafeInteger(issue.attempt) ? issue.attempt : null,
            result: issue.result,
            issues: Array.isArray(issue.issues)
              ? issue.issues.filter((entry): entry is string => typeof entry === 'string').slice(0, 20).map(entry => entry.slice(0, 100))
              : [],
            original: typeof issue.original === 'string' ? issue.original.slice(0, 2000) : null,
            candidate: typeof issue.candidate === 'string' ? issue.candidate.slice(0, 2000) : null
          });
        } catch { /* Ignore malformed historical JSONL records. */ }
      }
    } finally { await file.close(); }
    logAvailable = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { amazon: amazon.rows, persistedTranslations, translations, logAvailable, logLocation: '.agents/runtime/translation-warnings.jsonl' };
}
