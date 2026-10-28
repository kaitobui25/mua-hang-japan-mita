export const translationCron = '0 5 * * *';
export const translationTimezone = 'Asia/Tokyo';

/** 05:00 JST is 20:00 UTC on the previous calendar day. */
export function expectedTranslationAt(now = new Date()): Date {
  const due = new Date(now);
  due.setUTCHours(20, 0, 0, 0);
  if (due > now) due.setUTCDate(due.getUTCDate() - 1);
  return due;
}

/** No startup catch-up, even when the machine boots shortly after 05:00. */
export function shouldRunTranslation(createdAt: Date, startedAt: Date, now = new Date()): boolean {
  const due = expectedTranslationAt(now).getTime();
  return startedAt.getTime() <= due && createdAt.getTime() >= due &&
    createdAt.getTime() <= now.getTime() && now.getTime() - due <= 5 * 60 * 1000;
}
