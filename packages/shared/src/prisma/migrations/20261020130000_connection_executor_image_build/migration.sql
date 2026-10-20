-- Add the recorded executor-image build settings used by the scheduled
-- rebuild workflow: { stack: 'node'|'python'|'jvm', useRepoDockerfile: boolean }.
ALTER TABLE "connections" ADD COLUMN "executor_image_build" JSONB;
