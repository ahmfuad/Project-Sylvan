-- Plant health from the server's classification: set only for tree verdicts where leaves were
-- visible (a tub seen only from the side is a tree with unknown health, so NULL).
ALTER TABLE samples
  ADD COLUMN ai_health TEXT,
  ADD CONSTRAINT samples_ai_health_check CHECK (ai_health IN ('healthy', 'unhealthy')),
  ADD CONSTRAINT samples_ai_health_only_for_trees CHECK (ai_health IS NULL OR ai_label = 'tree');
