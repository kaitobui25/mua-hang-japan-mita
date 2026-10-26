CREATE TABLE IF NOT EXISTS categories (
  slug text PRIMARY KEY,
  name text NOT NULL,
  amazon_seed_url text NOT NULL,
  shipping_estimate_vnd integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  asin varchar(10) PRIMARY KEY CHECK (asin ~ '^[A-Z0-9]{10}$'),
  category_slug text NOT NULL REFERENCES categories(slug),
  name text NOT NULL,
  brand text,
  image_url text,
  source_url text NOT NULL,
  source_adapter text NOT NULL,
  rights_status text NOT NULL DEFAULT 'unverified',
  price_jpy integer CHECK (price_jpy IS NULL OR price_jpy >= 0),
  price_observed_at timestamptz,
  availability text NOT NULL DEFAULT 'unknown',
  sale_status text NOT NULL DEFAULT 'pending_review',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_category_idx ON products(category_slug, updated_at DESC);
CREATE INDEX IF NOT EXISTS products_price_idx ON products(price_jpy) WHERE price_jpy IS NOT NULL;

CREATE TABLE IF NOT EXISTS sync_runs (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  state text NOT NULL DEFAULT 'running',
  discovered_count integer NOT NULL DEFAULT 0,
  saved_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  note text
);
CREATE TABLE IF NOT EXISTS sync_errors (
  id bigserial PRIMARY KEY,
  sync_run_id bigint NOT NULL REFERENCES sync_runs(id),
  category_slug text,
  asin varchar(10),
  adapter text,
  state text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS price_observations (
  id bigserial PRIMARY KEY,
  asin varchar(10) NOT NULL REFERENCES products(asin),
  price_jpy integer NOT NULL,
  observed_at timestamptz NOT NULL,
  source_adapter text NOT NULL,
  sync_run_id bigint REFERENCES sync_runs(id),
  UNIQUE (asin, observed_at)
);
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  customer_email text,
  customer_address text NOT NULL,
  status text NOT NULL DEFAULT 'simulation_created',
  fx_jpy_to_vnd numeric(12,4) NOT NULL,
  service_fee_percent numeric(6,2) NOT NULL,
  merchandise_vnd bigint NOT NULL,
  estimated_shipping_vnd bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  order_id uuid NOT NULL REFERENCES orders(id),
  asin varchar(10) NOT NULL,
  name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  price_jpy integer NOT NULL,
  unit_price_vnd bigint NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (order_id, asin)
);

INSERT INTO categories(slug, name, amazon_seed_url, shipping_estimate_vnd) VALUES
 ('thuc-pham-bo-sung', 'Thực phẩm bổ sung · Whey protein', 'https://www.amazon.co.jp/gp/bestsellers/hpc/3457072051', 40000),
 ('thuc-pham-cho-be', 'Thực phẩm cho bé', 'https://www.amazon.co.jp/s?k=%E3%83%99%E3%83%93%E3%83%BC%E3%83%95%E3%83%BC%E3%83%89&i=food-beverage', 55000)
ON CONFLICT (slug) DO NOTHING;
