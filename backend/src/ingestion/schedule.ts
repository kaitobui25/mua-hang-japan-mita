export const dailyCron = '0 4 * * *';
export const dailyTimezone = 'Asia/Tokyo';
import { lastDueAtJst } from '../workers/settings.js';
export function expectedSyncAt(now = new Date(), hhmm = '04:00') {
  return lastDueAtJst(now, hhmm);
}

// Discard queued work from downtime; starting the worker never runs a catch-up scan.
// A five-minute dispatch allowance covers pg-boss polling around 04:00 JST.
export function shouldRunDaily(createdAt: Date, workerStartedAt: Date, now = new Date(), hhmm = '04:00') {
  const due = expectedSyncAt(now, hhmm).getTime();
  return workerStartedAt.getTime() <= due && createdAt.getTime() >= due &&
    createdAt.getTime() <= now.getTime() && now.getTime() - due <= 5 * 60 * 1000;
}
