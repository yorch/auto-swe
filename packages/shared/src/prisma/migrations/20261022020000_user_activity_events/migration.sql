-- CreateTable
CREATE TABLE "user_activity_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "via" TEXT,
    "kind" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "status" INTEGER,
    "request_id" TEXT,
    "ip" TEXT,
    "props" JSONB,

    CONSTRAINT "user_activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_activity_events_created_at_idx" ON "user_activity_events"("created_at");

-- CreateIndex
CREATE INDEX "user_activity_events_kind_created_at_idx" ON "user_activity_events"("kind", "created_at");

-- CreateIndex
CREATE INDEX "user_activity_events_actor_id_created_at_idx" ON "user_activity_events"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "user_activity_events_route_created_at_idx" ON "user_activity_events"("route", "created_at");

