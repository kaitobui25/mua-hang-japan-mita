-- Local-only, additive. Never apply implicitly to a live database.
CREATE TABLE IF NOT EXISTS worker_control_settings (
  id integer PRIMARY KEY CHECK(id=1),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  engine text NOT NULL DEFAULT 'openrouter' CHECK(engine IN ('openrouter','codex')),
  schedules jsonb NOT NULL DEFAULT '{"amazon":"04:00","names":"05:00","detail":"05:15"}'::jsonb CHECK(jsonb_typeof(schedules)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO worker_control_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS worker_control_audit (
  id bigserial PRIMARY KEY,
  actor_id text NOT NULL,
  before_value jsonb NOT NULL,
  after_value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
