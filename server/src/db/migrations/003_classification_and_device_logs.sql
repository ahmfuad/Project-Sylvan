-- Photo classification (sent by the ESP32 after its OpenAI call) and the sensor failure cause.
ALTER TABLE samples
  ADD COLUMN fail_reason         TEXT,
  ADD COLUMN classification      TEXT,
  ADD COLUMN classification_note TEXT,
  ADD COLUMN classified_at       TIMESTAMPTZ,
  ADD CONSTRAINT samples_classification_check
    CHECK (classification IN ('tree', 'object', 'unclear', 'error')),
  ADD CONSTRAINT samples_fail_reason_only_when_failed
    CHECK (fail_reason IS NULL OR NOT ok);

-- Debug trail from the ESP32 and, relayed by it, the ATmega32. Pruned by age and row count.
CREATE TABLE device_logs (
  id           BIGSERIAL PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  source       TEXT NOT NULL,
  level        TEXT NOT NULL,
  boot_id      TEXT,
  device_ms    BIGINT,
  message      TEXT NOT NULL,
  CONSTRAINT device_logs_source_check CHECK (source IN ('esp32', 'atmega')),
  CONSTRAINT device_logs_level_check CHECK (level IN ('debug', 'info', 'warn', 'error'))
);
CREATE INDEX device_logs_received_at_idx ON device_logs (received_at DESC, id DESC);
