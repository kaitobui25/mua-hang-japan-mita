-- Store the owner-facing alert in the same transaction as a real checkout.
-- An Admin alert is not evidence of a Zalo/Facebook message or payment.
CREATE TABLE IF NOT EXISTS order_notification_outbox (
  id bigserial PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type = 'order_placed'),
  recipient text NOT NULL CHECK (recipient = 'owner'),
  channel text NOT NULL CHECK (channel = 'admin'),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  UNIQUE (order_id, event_type, recipient, channel)
);
CREATE INDEX IF NOT EXISTS order_notification_outbox_unread_idx
  ON order_notification_outbox (id DESC) WHERE acknowledged_at IS NULL;
