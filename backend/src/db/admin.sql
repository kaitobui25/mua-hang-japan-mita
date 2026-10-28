ALTER TABLE products ADD COLUMN IF NOT EXISTS admin_hidden_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pricing_policy_version integer;

CREATE TABLE IF NOT EXISTS admin_accounts (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  password_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash text PRIMARY KEY,
  account_id integer NOT NULL REFERENCES admin_accounts(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at);
CREATE TABLE IF NOT EXISTS admin_login_limit (
  id integer PRIMARY KEY CHECK (id = 1),
  attempts integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO admin_login_limit(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS pricing_policy (
  id integer PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  fx_jpy_to_vnd numeric(12,4) NOT NULL CHECK (fx_jpy_to_vnd > 0 AND fx_jpy_to_vnd <= 10000),
  service_fee_percent numeric(6,2) NOT NULL CHECK (service_fee_percent >= 0 AND service_fee_percent <= 100),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- OFF by default: local_test_only products are included in the public catalog.
-- The owner can enable this switch to hide them again without changing rights_status.
CREATE TABLE IF NOT EXISTS catalog_settings (
  id integer PRIMARY KEY CHECK (id = 1),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  hide_local_test_only boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO catalog_settings(id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS admin_audit_events (
  id bigserial PRIMARY KEY,
  actor_id integer NOT NULL REFERENCES admin_accounts(id),
  action text NOT NULL,
  object_id text NOT NULL,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS catalog_import_requests (
  id uuid PRIMARY KEY,
  asin varchar(10) NOT NULL CHECK (asin ~ '^[A-Z0-9]{10}$'),
  category_slug text NOT NULL REFERENCES categories(slug),
  actor_id integer NOT NULL REFERENCES admin_accounts(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS catalog_import_active_asin_idx ON catalog_import_requests(asin)
  WHERE state IN ('pending','running');
CREATE INDEX IF NOT EXISTS catalog_import_pending_idx ON catalog_import_requests(created_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS catalog_import_created_idx ON catalog_import_requests(created_at DESC, id);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders(created_at DESC, id);
CREATE INDEX IF NOT EXISTS sync_errors_run_idx ON sync_errors(sync_run_id, id);
CREATE INDEX IF NOT EXISTS products_visibility_idx ON products(admin_hidden_at, last_seen_at DESC);
