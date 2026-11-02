-- Additive only. Applying this file to an active database requires separate approval.
-- Title provenance is independent of the legacy full-detail source hash/model.
ALTER TABLE product_translations ADD COLUMN IF NOT EXISTS name_revision bigint;
ALTER TABLE product_translations ADD COLUMN IF NOT EXISTS name_generation uuid;
ALTER TABLE product_translations ADD COLUMN IF NOT EXISTS name_model text;

-- Existing title writers remain compatible with an unmigrated DB. Once this
-- feature is installed, their edits cannot accidentally retain Codex provenance
-- for different content. Detail-only changes leave title revisions intact.
CREATE OR REPLACE FUNCTION mita_clear_stale_name_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name_revision IS NOT DISTINCT FROM OLD.name_revision AND
      (NEW.name IS DISTINCT FROM OLD.name OR NEW.name_source IS DISTINCT FROM OLD.name_source OR
       NEW.name_issues IS DISTINCT FROM OLD.name_issues) THEN
    NEW.name_revision := NULL;
    NEW.name_generation := NULL;
    NEW.name_model := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mita_name_revision_guard ON product_translations;
CREATE TRIGGER mita_name_revision_guard BEFORE UPDATE ON product_translations
  FOR EACH ROW EXECUTE FUNCTION mita_clear_stale_name_revision();

CREATE TABLE IF NOT EXISTS codex_name_cycles (
  id bigserial PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS codex_name_one_active_cycle
  ON codex_name_cycles ((true)) WHERE finished_at IS NULL;

CREATE TABLE IF NOT EXISTS codex_name_runs (
  id uuid PRIMARY KEY,
  trigger text NOT NULL CHECK (trigger IN ('manual','scheduled')),
  jst_day date NOT NULL,
  cycle_id bigint REFERENCES codex_name_cycles(id),
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','completed','partial','deferred','failed')),
  reason text,
  selected integer NOT NULL DEFAULT 0 CHECK (selected BETWEEN 0 AND 300),
  translated integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  warnings integer NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
-- A stopped/failed scheduled run is never silently replayed within its JST day.
CREATE UNIQUE INDEX IF NOT EXISTS codex_name_one_scheduled_day
  ON codex_name_runs(jst_day) WHERE trigger='scheduled';

CREATE TABLE IF NOT EXISTS codex_name_cycle_items (
  cycle_id bigint NOT NULL REFERENCES codex_name_cycles(id),
  asin varchar(10) NOT NULL REFERENCES products(asin) ON DELETE CASCADE,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  last_attempt_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY(cycle_id,asin)
);
CREATE INDEX IF NOT EXISTS codex_name_cycle_pending
  ON codex_name_cycle_items(cycle_id,last_attempt_at,asin)
  WHERE completed_at IS NULL AND attempts<3;

CREATE TABLE IF NOT EXISTS codex_name_run_items (
  run_id uuid NOT NULL REFERENCES codex_name_runs(id),
  asin varchar(10) NOT NULL REFERENCES products(asin) ON DELETE CASCADE,
  source jsonb NOT NULL,
  prior_name text,
  prior_updated_at text,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  outcome text NOT NULL DEFAULT 'selected' CHECK (outcome IN ('selected','saved','failed','source_changed')),
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY(run_id,asin)
);

CREATE TABLE IF NOT EXISTS codex_name_history (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES codex_name_runs(id),
  asin varchar(10) NOT NULL REFERENCES products(asin),
  source jsonb NOT NULL,
  source_hash text NOT NULL,
  previous jsonb NOT NULL,
  replacement jsonb NOT NULL,
  issues jsonb NOT NULL,
  model text NOT NULL,
  generation uuid NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,asin)
);
CREATE INDEX IF NOT EXISTS codex_name_history_asin ON codex_name_history(asin,id DESC);
