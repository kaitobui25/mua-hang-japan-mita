import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function repositoryRoot(): string {
  let root = dirname(fileURLToPath(import.meta.url));
  while (dirname(root) !== root) {
    if (existsSync(join(root, 'backend', 'package.json'))) return root;
    root = dirname(root);
  }
  // Server-only packages may be deployed without the repository marker.
  return fileURLToPath(new URL('../../../', import.meta.url));
}
export const warningLogPath = join(repositoryRoot(), '.agents', 'runtime', 'translation-warnings.jsonl');
export type TranslationAssessment = { text: string; issues: string[] };
/** Structural failures must never be displayed, even when semantic checks are relaxed. */
export function usableTranslation(value: unknown, maxLength = 6000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength ||
      /```|<\/?[a-z!][^>]*|(?:javascript|vbscript|data)\s*:|&(?:lt|#0*60|#x0*3c);|[\u0000-\u0008\u000b\u000c\u000e-\u001f]|^\s*[{[]/i.test(value)) throw new Error('invalid_output');
  return value;
}
export function assessTranslation(source: string, value: unknown, validate: (source: string, text: string) => unknown,
  maxLength = 6000): TranslationAssessment {
  const text = usableTranslation(value, maxLength);
  const issues: string[] = [];
  try { validate(source, text); }
  catch (error) { issues.push(error instanceof Error ? error.message : 'facts_changed'); }
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) issues.push('residual_japanese');
  return { text, issues: [...new Set(issues)] };
}
export type TranslationWarningEvent = {
  asin: string; locale: 'vi'; field: string; engine: string; model: string | null;
  attempt: number; original: string; candidate?: string; issues: string[];
  result: 'warning' | 'failed' | 'success';
  published?: boolean;
};
/** Explicit allowlist: never serialize errors, HTTP payloads, headers or credentials. */
export async function logTranslationEvent(event: TranslationWarningEvent, path = warningLogPath): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify({ timestamp: new Date().toISOString(), asin: event.asin,
    locale: event.locale, field: event.field, engine: event.engine, model: event.model,
    attempt: event.attempt, original: event.original, candidate: event.candidate,
    sourceHash: createHash('sha256').update(event.original).digest('hex'),
    severity: event.result === 'failed' ? 'error' : event.result === 'warning' ? 'warning' : 'info',
    published: event.published, issues: event.issues, result: event.result }) + '\n', 'utf8');
}
