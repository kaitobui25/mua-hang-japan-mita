-- Per-recipient SMTP delivery receipts for durable real order_placed alerts.
-- Checkout only inserts order_notification_outbox: email is processed later.
-- Migration MUST NOT insert the activation row. Initial enable only sees new events.
CREATE TABLE IF NOT EXISTS order_email_delivery_activation (
  id smallint PRIMARY KEY CHECK (id=1),
  activated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_email_deliveries (
  id bigserial PRIMARY KEY,
  event_id bigint NOT NULL REFERENCES order_notification_outbox(id) ON DELETE RESTRICT,
  recipient_email text NOT NULL
    CHECK (recipient_email IN ('mitajapan@gmail.com', 'nothink1315@gmail.com')),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'sending', 'sent', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_failure_code text CHECK (last_failure_code IN ('smtp_transient', 'smtp_permanent')),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, recipient_email),
  CHECK (state <> 'sent' OR sent_at IS NOT NULL),
  CHECK (state <> 'sending' OR lease_until IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS order_email_deliveries_work_idx
  ON order_email_deliveries(next_attempt_at, id) WHERE state IN ('pending', 'sending');
