export const translationCron = '0 5 * * *';
export const translationTimezone = 'Asia/Tokyo';
import { lastDueAtJst } from '../workers/settings.js';

/** 05:00 JST is 20:00 UTC on the previous calendar day. */
export function expectedTranslationAt(now = new Date(), hhmm = '05:00'): Date {
  return lastDueAtJst(now, hhmm);
}

/** No startup catch-up, even when the machine boots shortly after 05:00. */
export function shouldRunTranslation(createdAt: Date, startedAt: Date, now = new Date(), hhmm = '05:00'): boolean {
  const due = expectedTranslationAt(now, hhmm).getTime();
  return startedAt.getTime() <= due && createdAt.getTime() >= due &&
    createdAt.getTime() <= now.getTime() && now.getTime() - due <= 5 * 60 * 1000;
}
