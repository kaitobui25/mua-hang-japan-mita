import { config } from './config.js';

// Explicit local demo quote. Exchange rate / service fee are not live financial data.
export function toVnd(priceJpy: number): number {
  return Math.round(priceJpy * config.fxJpyToVnd * (1 + config.serviceFeePercent / 100) / 1000) * 1000;
}

export function isFresh(value: Date | string | null): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now() && Date.now() - timestamp <= 24 * 60 * 60 * 1000;
}
