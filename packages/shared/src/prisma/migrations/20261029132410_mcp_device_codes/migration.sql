CREATE TABLE "device_codes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "device_code" TEXT NOT NULL,
  "user_code" TEXT NOT NULL,
  "user_id" UUID,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "status" TEXT NOT NULL,
  "last_polled_at" TIMESTAMPTZ,
  "polling_interval" INTEGER,
  "client_id" TEXT,
  "scope" TEXT,
  "resources" TEXT[] NOT NULL,
  "oauth_client_id" TEXT,
  CONSTRAINT "device_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "device_codes_device_code_key" ON "device_codes"("device_code");
CREATE UNIQUE INDEX "device_codes_user_code_key" ON "device_codes"("user_code");
CREATE INDEX "device_codes_user_id_oauth_client_id_idx" ON "device_codes"("user_id", "oauth_client_id");
