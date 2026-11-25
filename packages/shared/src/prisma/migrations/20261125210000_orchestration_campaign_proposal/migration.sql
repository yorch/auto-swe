-- A campaign the orchestrator proposed, recorded as a card the launcher reviews. Added alone:
-- PostgreSQL refuses to use an enum value added in the same transaction, and nothing here uses it.

-- AlterEnum
ALTER TYPE "OrchestrationMessageKind" ADD VALUE 'CAMPAIGN_PROPOSAL';
