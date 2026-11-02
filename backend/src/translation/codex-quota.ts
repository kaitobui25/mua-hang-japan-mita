type Window = { usedPercent: number; windowDurationMins: number; resetsAt: number };
export type CodexQuota = { allowed: boolean; reason: 'ready' | 'quota_unknown' | 'quota_low' | 'quota_exhausted'; remainingFiveHour: number | null };
const unknown: CodexQuota = { allowed: false, reason: 'quota_unknown', remainingFiveHour: null };
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Only a fresh account/rateLimits/read response from the translating app-server
 * session is evidence. Never assume primary is the rolling five-hour window.
 * https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt */
export function assessCodexQuota(payload: unknown, observedAt: Date, now = new Date()): CodexQuota {
  const age = now.getTime() - observedAt.getTime();
  if (!Number.isFinite(age) || age < 0 || age > 30000 || !object(payload)) return unknown;
  let bucket: unknown;
  if (payload.rateLimitsByLimitId !== undefined && payload.rateLimitsByLimitId !== null) {
    if (!object(payload.rateLimitsByLimitId)) return unknown;
    bucket = payload.rateLimitsByLimitId.codex;
  } else bucket = payload.rateLimits;
  if (!object(bucket) || bucket.limitId !== 'codex') return unknown;
  const windows: Window[] = [];
  for (const key of ['primary', 'secondary']) {
    const value = bucket[key];
    if (value === null || value === undefined) continue;
    if (!object(value) || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent) ||
        value.usedPercent < 0 || value.usedPercent > 100 || !Number.isSafeInteger(value.windowDurationMins) ||
        Number(value.windowDurationMins) <= 0 || !Number.isSafeInteger(value.resetsAt) ||
        Number(value.resetsAt) * 1000 <= now.getTime()) return unknown;
    windows.push(value as Window);
  }
  const fiveHour = windows.filter(window => window.windowDurationMins === 300);
  if (fiveHour.length !== 1) return unknown;
  const remainingFiveHour = 100 - fiveHour[0].usedPercent;
  if (bucket.rateLimitReachedType || windows.some(window => window.usedPercent >= 100)) {
    return { allowed: false, reason: 'quota_exhausted', remainingFiveHour };
  }
  return { allowed: remainingFiveHour >= 20, reason: remainingFiveHour >= 20 ? 'ready' : 'quota_low', remainingFiveHour };
}
