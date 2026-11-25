-- CreateTable
CREATE TABLE "plugin_mcp_mappings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "profile_id" UUID NOT NULL,
    "server_name" TEXT NOT NULL,
    "connection_id" UUID NOT NULL,
    "mapped_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plugin_mcp_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plugin_mcp_mappings_connection_id_idx" ON "plugin_mcp_mappings"("connection_id");

-- CreateIndex
CREATE INDEX "plugin_mcp_mappings_mapped_by_id_idx" ON "plugin_mcp_mappings"("mapped_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "plugin_mcp_mappings_profile_id_server_name_key" ON "plugin_mcp_mappings"("profile_id", "server_name");

-- AddForeignKey
ALTER TABLE "plugin_mcp_mappings" ADD CONSTRAINT "plugin_mcp_mappings_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "harness_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_mcp_mappings" ADD CONSTRAINT "plugin_mcp_mappings_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plugin_mcp_mappings" ADD CONSTRAINT "plugin_mcp_mappings_mapped_by_id_fkey" FOREIGN KEY ("mapped_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

