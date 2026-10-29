-- Versioned, optional visual title. Original products.name and translation rows
-- are immutable historical evidence. Stale presentations are never published.
CREATE TABLE IF NOT EXISTS product_title_presentations (
  asin varchar(10) PRIMARY KEY REFERENCES products(asin) ON DELETE CASCADE,
  source_name text NOT NULL,
  translated_name text NOT NULL,
  short_name text NOT NULL CHECK (char_length(short_name) BETWEEN 8 AND 120),
  omitted_facts jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(omitted_facts) = 'array'),
  model text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
