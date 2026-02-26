CREATE TABLE IF NOT EXISTS "agent_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id"),
  "type" text NOT NULL,
  "status" text NOT NULL DEFAULT 'OPEN',
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp without time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "agent_tasks_merchant_idx" ON "agent_tasks"("merchant_id");

CREATE TABLE IF NOT EXISTS "message_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "merchant_id" uuid NOT NULL REFERENCES "merchants"("id"),
  "name" text NOT NULL,
  "channel" text NOT NULL DEFAULT 'whatsapp',
  "body" text NOT NULL,
  "created_at" timestamp without time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "message_templates_merchant_idx" ON "message_templates"("merchant_id");
