import { db } from './db/pool.js';
import type { PoolClient } from 'pg';

export type PricingPolicy = { version: number; fxJpyToVnd: number; serviceFeePercent: number };
export function validatePolicy(value: { fxJpyToVnd: number; serviceFeePercent: number }) {
  const { fxJpyToVnd: fx, serviceFeePercent: fee } = value;
  if (typeof fx !== 'number' || !Number.isFinite(fx) || fx <= 0 || fx > 10000 ||
      typeof fee !== 'number' || !Number.isFinite(fee) || fee < 0 || fee > 100 ||
      Math.abs(fx * 10000 - Math.round(fx * 10000)) > 0.000001 ||
      Math.abs(fee * 100 - Math.round(fee * 100)) > 0.000001) {
    throw new Error('Tỷ giá phải > 0 và ≤ 10.000 (4 số lẻ); phụ phí từ 0 đến 100% (2 số lẻ).');
  }
}
export async function getPricingPolicy(client: Pick<PoolClient, 'query'> = db): Promise<PricingPolicy> {
  const result = await client.query('SELECT version,fx_jpy_to_vnd,service_fee_percent FROM pricing_policy WHERE id=1');
  if (!result.rows[0]) throw new Error('Run db:migrate before serving prices');
  const p = result.rows[0];
  return { version: p.version, fxJpyToVnd: Number(p.fx_jpy_to_vnd), serviceFeePercent: Number(p.service_fee_percent) };
}

// Explicit local demo quote. Exchange rate / service fee are not live financial data.
export function toVnd(priceJpy: number, policy: Pick<PricingPolicy, 'fxJpyToVnd' | 'serviceFeePercent'>): number {
  return Math.round(priceJpy * policy.fxJpyToVnd * (1 + policy.serviceFeePercent / 100) / 1000) * 1000;
}

export function isFresh(value: Date | string | null): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now() && Date.now() - timestamp <= 24 * 60 * 60 * 1000;
}
