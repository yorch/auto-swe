-- The new enum values are added alone, in their own migration: PostgreSQL refuses to use a value
-- added in the same transaction, and the next migration backfills rows with them.

-- AlterEnum
ALTER TYPE "CampaignState" ADD VALUE 'ACTIVE';
ALTER TYPE "CampaignState" ADD VALUE 'PLANNING';
ALTER TYPE "CampaignState" ADD VALUE 'PAUSED';
ALTER TYPE "CampaignState" ADD VALUE 'MONITORING';

-- AlterEnum
ALTER TYPE "CampaignTargetState" ADD VALUE 'BLOCKED';
ALTER TYPE "CampaignTargetState" ADD VALUE 'MERGED';
ALTER TYPE "CampaignTargetState" ADD VALUE 'SATISFIED';
ALTER TYPE "CampaignTargetState" ADD VALUE 'NEEDS_ATTENTION';
