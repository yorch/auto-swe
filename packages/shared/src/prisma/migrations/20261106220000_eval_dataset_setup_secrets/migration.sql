-- AlterTable
ALTER TABLE "eval_datasets" ADD COLUMN     "setup_secrets_connection_id" UUID;

-- AddForeignKey
ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_setup_secrets_connection_id_fkey" FOREIGN KEY ("setup_secrets_connection_id") REFERENCES "connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
