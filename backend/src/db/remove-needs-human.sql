-- Run in the schema migration transaction under the shared Amazon access lock.
SELECT pg_advisory_xact_lock(70400200);
ALTER TABLE source_access_blocks ADD COLUMN IF NOT EXISTS retry_after_at timestamptz;
CREATE TABLE IF NOT EXISTS source_access_block_history (
  id bigserial PRIMARY KEY, source text NOT NULL, reason text NOT NULL,
  blocked_at timestamptz NOT NULL, retired_at timestamptz NOT NULL DEFAULT now(),
  block_snapshot jsonb NOT NULL, decision text NOT NULL
);
CREATE TABLE IF NOT EXISTS data_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
-- Replace state constraints even if a legacy installation used custom names.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conrelid::regclass AS tbl,conname FROM pg_constraint
    WHERE conrelid IN ('product_detail_queue'::regclass,'catalog_import_requests'::regclass,'sync_runs'::regclass)
      AND contype='c' AND pg_get_constraintdef(oid) ~ '\mstate\M'
  LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.tbl,c.conname); END LOOP;
END $$;
UPDATE product_detail_queue SET state='pending' WHERE state='needs_human';
UPDATE sync_runs SET state=CASE WHEN saved_count>0 THEN 'partial' ELSE 'failed' END WHERE state='needs_human';
-- Deterministic winner for duplicate ASINs; preserve errors and attempt times.
WITH ranked AS (
  SELECT id,row_number() OVER(PARTITION BY asin ORDER BY
    CASE WHEN state IN ('pending','running') THEN 0 ELSE 1 END,created_at,id) AS n
  FROM catalog_import_requests WHERE state IN ('pending','running','needs_human')
)
UPDATE catalog_import_requests r SET state=CASE WHEN ranked.n=1 THEN 'pending' ELSE 'failed' END
  FROM ranked WHERE r.id=ranked.id AND r.state='needs_human';
ALTER TABLE product_detail_queue ADD CONSTRAINT product_detail_queue_state_check CHECK(state IN ('pending','success','failed'));
ALTER TABLE catalog_import_requests ADD CONSTRAINT catalog_import_requests_state_check CHECK(state IN ('pending','running','succeeded','failed'));
ALTER TABLE sync_runs ADD CONSTRAINT sync_runs_state_check CHECK(state IN ('running','success','partial','failed'));

-- Q5=A: retire only the pre-cooldown block once. A new denial always has a
-- retry_after_at and must never be removed by this migration, including reruns.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM data_migrations WHERE name='09_remove_needs_human_q5_a') THEN
    INSERT INTO source_access_block_history(source,reason,blocked_at,block_snapshot,decision)
      SELECT source,reason,blocked_at,to_jsonb(b),'09 Q5=A owner manually confirmed Amazon access'
      FROM source_access_blocks b WHERE source='amazon.co.jp' AND retry_after_at IS NULL;
    DELETE FROM source_access_blocks WHERE source='amazon.co.jp' AND retry_after_at IS NULL;
    INSERT INTO data_migrations(name) VALUES('09_remove_needs_human_q5_a');
  END IF;
END $$;
