export const detailTranslationCron = '15 5 * * *';
export const detailTranslationTimezone = 'Asia/Tokyo';
import { lastDueAtJst } from '../workers/settings.js';

export function shouldRunDetailTranslation(createdAt: Date, startedAt: Date, now = new Date(), hhmm = '05:15'): boolean {
  const due = lastDueAtJst(now, hhmm);
  return startedAt.getTime() <= due.getTime() && createdAt.getTime() >= due.getTime() &&
    createdAt.getTime() <= now.getTime() && now.getTime() - due.getTime() <= 5 * 60 * 1000;
}

export function parseDetailCommand(args: string[]): { command: 'once' | 'daily'; limit?: number } {
  const [command, flag, value, ...rest] = args;
  if ((command !== 'once' && command !== 'daily') || rest.length ||
      (flag !== undefined && (command !== 'once' || flag !== '--limit' || !/^\d+$/.test(value ?? '')))) {
    throw new Error('Usage: detail-translator.ts daily | once [--limit 3]');
  }
  const limit = value === undefined ? undefined : Number(value);
  if (limit !== undefined && (limit < 1 || limit > 1000)) throw new Error('--limit must be 1..1000');
  return { command, limit };
}
