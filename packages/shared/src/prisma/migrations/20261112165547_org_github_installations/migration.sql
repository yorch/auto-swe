ALTER TABLE "github_installations" ADD COLUMN "organization_id" UUID;
CREATE INDEX "github_installations_organization_id_idx" ON "github_installations"("organization_id");
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
