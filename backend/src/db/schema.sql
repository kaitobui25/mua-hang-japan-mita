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
  variant_group_basis text,
  variant_group_id text,
  price_jpy integer CHECK (price_jpy IS NULL OR price_jpy >= 0),
  price_observed_at timestamptz,
  availability text NOT NULL DEFAULT 'unknown',
  sale_status text NOT NULL DEFAULT 'pending_review',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Idempotent for installations whose products table predates variant grouping.
-- Existing products stay ungrouped: we never derive a family from the name or ASIN.
ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_group_basis text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_group_id text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'products'::regclass AND conname = 'products_variant_group_valid'
  ) THEN
    ALTER TABLE products ADD CONSTRAINT products_variant_group_valid CHECK (
      (variant_group_basis IS NULL) = (variant_group_id IS NULL)
      AND (
        variant_group_basis IS NULL
        OR (variant_group_basis = 'parent_asin' AND variant_group_id ~ '^[A-Z0-9]{10}$')
        OR (variant_group_basis = 'source_product_id' AND length(variant_group_id) BETWEEN 3 AND 128
          AND variant_group_id ~ '^[A-Za-z0-9_.:-]+$')
      )
    );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS products_category_idx ON products(category_slug, updated_at DESC);
CREATE INDEX IF NOT EXISTS products_price_idx ON products(price_jpy) WHERE price_jpy IS NOT NULL;
CREATE INDEX IF NOT EXISTS products_variant_group_idx
  ON products(category_slug, variant_group_basis, variant_group_id)
  WHERE variant_group_basis IS NOT NULL AND variant_group_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_images (
  asin varchar(10) NOT NULL REFERENCES products(asin) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 5),
  source_url text NOT NULL CHECK (source_url ~ '^https://(m\.media-amazon\.com|images-na\.ssl-images-amazon\.com|images-fe\.ssl-images-amazon\.com)/'),
  source_observed_at timestamptz NOT NULL,
  PRIMARY KEY (asin, position),
  UNIQUE (asin, source_url)
);
CREATE TABLE IF NOT EXISTS product_details (
  asin varchar(10) PRIMARY KEY REFERENCES products(asin) ON DELETE CASCADE,
  features jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(features) = 'array'),
  ingredients jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(ingredients) = 'array'),
  usage jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(usage) = 'array'),
  specs jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(specs) = 'object'),
  cautions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(cautions) = 'array'),
  variant_attributes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(variant_attributes) = 'object'),
  child_asins jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(child_asins) = 'array'),
  source_observed_at timestamptz NOT NULL,
  provenance jsonb NOT NULL CHECK (jsonb_typeof(provenance) = 'object')
);
-- Reserved contract for a separate translator. Original names remain in products.
CREATE TABLE IF NOT EXISTS product_translations (
  asin varchar(10) NOT NULL REFERENCES products(asin) ON DELETE CASCADE,
  locale text NOT NULL DEFAULT 'vi',
  name text,
  detail jsonb,
  source_hash text NOT NULL,
  model text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','success','failed')),
  translated_at timestamptz,
  detail_attempted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asin, locale)
);
-- Incremental translation: a verified Vietnamese title may be published while
-- the larger description still awaits free model quota. Existing rows default
-- to fully translated (false) for backward compatibility.
ALTER TABLE product_translations ADD COLUMN IF NOT EXISTS name_only boolean NOT NULL DEFAULT false;
ALTER TABLE product_translations ADD COLUMN IF NOT EXISTS detail_attempted_at timestamptz;
-- Immutable source snapshots and independently durable atomic translations.
CREATE TABLE IF NOT EXISTS local_detail_translations (
  asin varchar(10) PRIMARY KEY REFERENCES products(asin) ON DELETE CASCADE,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS local_detail_translation_items (
  asin varchar(10) NOT NULL REFERENCES local_detail_translations(asin) ON DELETE CASCADE,
  slot text NOT NULL,
  source text NOT NULL,
  translated text,
  model text,
  attempts integer NOT NULL DEFAULT 0,
  retry_after timestamptz,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asin, slot)
);
-- Also holds discovered children before they have a valid product snapshot.
CREATE TABLE IF NOT EXISTS product_detail_queue (
  category_slug text NOT NULL REFERENCES categories(slug),
  asin varchar(10) NOT NULL CHECK (asin ~ '^[A-Z0-9]{10}$'),
  parent_asin varchar(10) CHECK (parent_asin IS NULL OR parent_asin ~ '^[A-Z0-9]{10}$'),
  provenance jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','success','failed')),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category_slug, asin)
);
-- Global source deny marker: a listing 403/CAPTCHA may have no ASIN and must
-- still block all source entrypoints until the next eligible daily re-entry.
CREATE TABLE IF NOT EXISTS source_access_blocks (
  source text PRIMARY KEY,
  reason text NOT NULL,
  blocked_at timestamptz NOT NULL DEFAULT now(),
  retry_after_at timestamptz,
  continuation_due_at timestamptz,
  timeout_recorded_at timestamptz
);
ALTER TABLE source_access_blocks ADD COLUMN IF NOT EXISTS retry_after_at timestamptz;
ALTER TABLE source_access_blocks ADD COLUMN IF NOT EXISTS continuation_due_at timestamptz;
ALTER TABLE source_access_blocks ADD COLUMN IF NOT EXISTS timeout_recorded_at timestamptz;
CREATE INDEX IF NOT EXISTS product_detail_queue_fair_idx
  ON product_detail_queue(category_slug, last_attempt_at NULLS FIRST, enqueued_at, asin);

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

-- Additive WARNING metadata; retain existing approved output and precise counters.
ALTER TABLE product_translations DROP CONSTRAINT IF EXISTS product_translations_status_check;
ALTER TABLE product_translations ADD CONSTRAINT product_translations_status_check
  CHECK (status IN ('pending','success','failed','warning'));
ALTER TABLE product_translations ADD COLUMN IF NOT EXISTS name_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE product_translations ADD COLUMN IF NOT EXISTS name_source jsonb;
ALTER TABLE product_translations ADD COLUMN IF NOT EXISTS name_issues jsonb NOT NULL DEFAULT '[]';
ALTER TABLE local_detail_translation_items ADD COLUMN IF NOT EXISTS warning boolean NOT NULL DEFAULT false;
ALTER TABLE local_detail_translation_items ADD COLUMN IF NOT EXISTS issues jsonb NOT NULL DEFAULT '[]';

-- A legacy full detail approval is independent of a missing/warned title.
ALTER TABLE product_translations ADD COLUMN IF NOT EXISTS detail_approved boolean NOT NULL DEFAULT false;
UPDATE product_translations SET detail_approved=true
  WHERE status='success' AND NOT name_only AND detail IS NOT NULL AND NOT detail_approved;


-- Real checkout is explicit in application INSERTs. Preserve simulation defaults
-- and all historical statuses; never reinterpret existing orders as real sales.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'unpaid';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method text NOT NULL DEFAULT 'manual';
-- Provider-neutral identifiers only: no payment secrets or card data.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_provider text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_reference text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_final_vnd bigint
  CHECK (shipping_final_vnd IS NULL OR shipping_final_vnd >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at timestamptz;
-- Once-only English detail backfill checkpoint for frozen GGUF snapshots.
-- NULL on legacy rows intentionally queues a bounded scan; no translated items are reset.
ALTER TABLE local_detail_translations ADD COLUMN IF NOT EXISTS english_slots_backfilled_at timestamptz;
