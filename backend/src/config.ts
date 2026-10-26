export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://mita_local@127.0.0.1:5433/postgres',
  port: Number(process.env.API_PORT ?? 4000),
  fxJpyToVnd: Number(process.env.FX_JPY_TO_VND ?? 190),
  serviceFeePercent: Number(process.env.SERVICE_FEE_PERCENT ?? 12),
  maxDiscover: Math.min(200, Number(process.env.MAX_DISCOVER_PER_CATEGORY ?? 200)),
  amazonTimeoutMs: Number(process.env.AMAZON_TIMEOUT_MS ?? 15000),
  neoUrl: process.env.NEO_MCP_URL ?? 'http://127.0.0.1:9010/mcp'
};
