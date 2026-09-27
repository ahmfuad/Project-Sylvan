-- The server's own OpenAI verdict for each photo, with the model's confidence. Kept separate
-- from the rover's verdict (classification*), which the ESP32 reports for its OLED.
ALTER TABLE samples
  ADD COLUMN ai_label         TEXT,
  ADD COLUMN ai_confidence    REAL,
  ADD COLUMN ai_model         TEXT,
  ADD COLUMN ai_note          TEXT,
  ADD COLUMN ai_attempts      SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN ai_classified_at TIMESTAMPTZ,
  ADD CONSTRAINT samples_ai_label_check
    CHECK (ai_label IN ('tree', 'object', 'unclear', 'error')),
  ADD CONSTRAINT samples_ai_confidence_range
    CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1));

-- The classification worker's queue: photos without a verdict yet, newest first.
CREATE INDEX samples_ai_pending_idx ON samples (id DESC)
  WHERE ai_label IS NULL AND photo_key IS NOT NULL;
