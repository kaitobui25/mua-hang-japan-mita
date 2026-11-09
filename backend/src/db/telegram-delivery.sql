-- Additive only: no activation row or historic delivery backfill.
CREATE TABLE IF NOT EXISTS order_telegram_delivery_activation (
  id smallint PRIMARY KEY CHECK (id=1),
  activated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS order_telegram_deliveries (
  id bigserial PRIMARY KEY,
  event_id bigint NOT NULL REFERENCES order_notification_outbox(id) ON DELETE RESTRICT,
  chat_id text NOT NULL CHECK (chat_id='7480163903'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_failure_code text CHECK (last_failure_code IN ('telegram_transient','telegram_permanent','telegram_rate_limit')),
  message_id bigint CHECK (message_id>0),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(event_id,chat_id),
  CHECK (state<>'sent' OR (sent_at IS NOT NULL AND message_id IS NOT NULL)),
  CHECK (state<>'sending' OR lease_until IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS order_telegram_deliveries_work_idx
  ON order_telegram_deliveries(next_attempt_at,id) WHERE state IN ('pending','sending');
