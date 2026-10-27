export const dailyCron = '0 4 * * *';
export const dailyTimezone = 'Asia/Tokyo';
export function expectedSyncAt(now = new Date()) {
  // 04:00 JST is 19:00 UTC on the preceding calendar date. No DST in Japan.
  const expected = new Date(now);
  expected.setUTCHours(19, 0, 0, 0);
  if (expected > now) expected.setUTCDate(expected.getUTCDate() - 1);
  return expected;
}

// Discard queued work from downtime; starting the worker never runs a catch-up scan.
// A five-minute dispatch allowance covers pg-boss polling around 04:00 JST.
export function shouldRunDaily(createdAt: Date, workerStartedAt: Date, now = new Date()) {
  const due = expectedSyncAt(now).getTime();
  return workerStartedAt.getTime() <= due && createdAt.getTime() >= due &&
    createdAt.getTime() <= now.getTime() && now.getTime() - due <= 5 * 60 * 1000;
}
