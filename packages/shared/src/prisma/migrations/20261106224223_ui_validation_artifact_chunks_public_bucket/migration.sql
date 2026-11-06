-- AlterTable
ALTER TABLE "run_evidence" ADD COLUMN     "public_bucket" TEXT;

-- CreateTable
CREATE TABLE "workflow_artifact_chunks" (
    "artifact_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,

    CONSTRAINT "workflow_artifact_chunks_pkey" PRIMARY KEY ("artifact_id","seq")
);

-- AddForeignKey
ALTER TABLE "workflow_artifact_chunks" ADD CONSTRAINT "workflow_artifact_chunks_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "workflow_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
