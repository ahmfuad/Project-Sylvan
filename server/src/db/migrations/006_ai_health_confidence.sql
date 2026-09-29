-- Separate confidence for the healthy/unhealthy answer (ai_confidence is for tree/object).
ALTER TABLE samples
  ADD COLUMN ai_health_confidence REAL,
  ADD CONSTRAINT samples_ai_health_confidence_range
    CHECK (ai_health_confidence IS NULL OR (ai_health_confidence >= 0 AND ai_health_confidence <= 1));
