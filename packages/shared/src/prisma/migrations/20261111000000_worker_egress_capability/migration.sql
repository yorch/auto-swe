CREATE TABLE "worker_egress_capabilities" (
    "id" TEXT NOT NULL,
    "backend" TEXT NOT NULL,
    "egress_proxy" BOOLEAN NOT NULL,
    "registry_proxy" BOOLEAN NOT NULL,
    "network_lock" BOOLEAN NOT NULL,
    "detail" TEXT NOT NULL,
    "reported_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_egress_capabilities_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "worker_egress_capabilities_reported_at_idx" ON "worker_egress_capabilities"("reported_at");
