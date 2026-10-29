function poolLimit(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error(`${name} must be an integer from 1 to 10`);
  return value;
}

if (process.env.MITA_VPS_WORKER === '1') {
  const target = new URL(process.env.DATABASE_URL ?? '');
  if (process.platform !== 'win32' || target.hostname !== '127.0.0.1' || target.port !== '15432' ||
      !['postgres:', 'postgresql:'].includes(target.protocol) || target.search) {
    throw new Error('VPS collector requires Windows and DATABASE_URL on 127.0.0.1:15432 without query overrides');
  }
}

export const config = {
  dbPoolMax: poolLimit('DB_POOL_MAX', 3),
  bossPoolMax: poolLimit('PG_BOSS_POOL_MAX', 2),
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://mita_local@127.0.0.1:5433/postgres',
  port: Number(process.env.API_PORT ?? 4000),
  webPort: Number(process.env.WEB_PORT ?? 3000),
  fxJpyToVnd: Number(process.env.FX_JPY_TO_VND ?? 190),
  serviceFeePercent: Number(process.env.SERVICE_FEE_PERCENT ?? 12),
  maxDiscover: Math.min(200, Number(process.env.MAX_DISCOVER_PER_CATEGORY ?? 200)),
  amazonTimeoutMs: Number(process.env.AMAZON_TIMEOUT_MS ?? 15000),
  neoUrl: process.env.NEO_MCP_URL ?? 'http://127.0.0.1:9010/mcp',
  strictTop100: process.env.MITA_STRICT_TOP100 === '1',
  publicReadOnly: process.env.PUBLIC_READ_ONLY === '1'
};
