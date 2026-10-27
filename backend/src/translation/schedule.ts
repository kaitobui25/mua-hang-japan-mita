export const TRANSLATION_ACTIVE_DELAY_MS = 30_000;
export const TRANSLATION_IDLE_DELAY_MS = 2 * 60 * 60 * 1000;

/** Keep filling existing verified-source fields while the PC is running.
 * When requests cannot yield valid translations, wait instead of burning quota.
 */
export function nextTranslationDelayMs(result: { translated: number; paused?: boolean }): number {
  return result.translated > 0 && !result.paused ? TRANSLATION_ACTIVE_DELAY_MS : TRANSLATION_IDLE_DELAY_MS;
}
