export type PageResult<T> = { items: T[]; total: number; page: number; limit: number };
export type AdminProduct = { asin: string; name: string; imageUrl: string | null; categorySlug: string; priceVnd: number | null; hiddenAt: string | null; canCheckout: boolean };
export type ImportRequest = { id: string; asin: string; category_slug: string; state: 'pending' | 'running' | 'succeeded' | 'failed' | 'needs_human'; error: string | null; created_at: string };
export type AdminOrder = { id: string; created_at: string; customer_name: string; status: string; merchandise_vnd: string; item_count: number };
export type OrderDetail = AdminOrder & { customer_phone: string; customer_email: string | null; customer_address: string; estimated_shipping_vnd: string; fx_jpy_to_vnd: string; service_fee_percent: string; pricing_policy_version: number | null; items: { asin: string; name: string; quantity: number; price_jpy: number; unit_price_vnd: string; observed_at: string }[] };
export type Policy = { version: number; fxJpyToVnd: number; serviceFeePercent: number; exampleVnd: number };
export type SyncRun = { id: string; state: string; started_at: string; finished_at: string | null; discovered_count: number; saved_count: number; error_count: number; note: string | null };
export type Overview = { orders_7_days: number; visible_products: number; latestSync: SyncRun | null; syncErrors: { id: string; state: string; message: string; category_slug: string | null; created_at: string }[]; expectedSyncAt: string; missingScheduledRun: boolean; recentOrders: AdminOrder[] };
