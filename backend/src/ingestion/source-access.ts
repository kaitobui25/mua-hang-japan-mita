// Session-wide Amazon mutex shared by discovery/backfill and Admin imports.
// Hold this on the same PostgreSQL connection until all source requests finish.
export const AMAZON_ACCESS_LOCK = 70400200;
