-- Commercial targets.
--
-- A target is not a rule. Rules live in packages/config with a version because
-- changing one reinterprets history; a target is just the number someone is
-- aiming at this quarter, so it belongs in the database where the CCO can
-- change it without a deploy.
--
-- Company-wide by definition: progress against it must read the same for a rep
-- and for the founder.

CREATE TABLE IF NOT EXISTS "commercial_targets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "label" text NOT NULL,
  "metric" text NOT NULL,
  "target" integer NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_by" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- One live target per metric. Superseding deactivates the old row rather than
-- editing it, so last quarter's aim stays on record.
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_targets_active_metric_idx"
  ON "commercial_targets" ("metric")
  WHERE "active";

INSERT INTO "commercial_targets" ("label", "metric", "target")
SELECT 'Q4 milestone', 'merchants_on_mesa', 50
WHERE NOT EXISTS (
  SELECT 1 FROM "commercial_targets" WHERE "metric" = 'merchants_on_mesa' AND "active"
);
