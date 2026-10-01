-- ── Infrastructure configuration moves from the admin UI to the environment ──
-- Google / Okta / GitHub sign-in credentials, artifact storage, and the
-- container-sizing and scanner/sidecar knobs are now read from environment
-- variables only (see docs/configuration.md, "Bootstrap" tier).
--
-- Dropping the columns would silently discard whatever an operator saved in the
-- UI, and the deployment would come back up with the built-in defaults — for
-- sign-in that means a login provider vanishing, for storage it means artifacts
-- written to Postgres instead of S3. So refuse to proceed while any of those
-- values still exists, and say exactly which environment variables replace
-- them. Migrations run on every container boot, so this fails the deploy
-- loudly instead of degrading it quietly.
--
-- To acknowledge a value you have already copied into the environment, clear it
-- with the statement printed in the error, then re-run the migration.
DO $$
DECLARE
  found text[] := ARRAY[]::text[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM "google_oauth_config"
    WHERE "client_id" IS NOT NULL OR "client_secret_ciphertext" IS NOT NULL
  ) THEN
    found := array_append(found, 'Google sign-in (google_oauth_config) -> GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET; then: DELETE FROM google_oauth_config;'::text);
  END IF;

  IF EXISTS (
    SELECT 1 FROM "okta_oauth_config"
    WHERE "issuer" IS NOT NULL OR "client_id" IS NOT NULL OR "client_secret_ciphertext" IS NOT NULL
  ) THEN
    found := array_append(found, 'Okta SSO (okta_oauth_config) -> OKTA_ISSUER, OKTA_CLIENT_ID, OKTA_CLIENT_SECRET; then: DELETE FROM okta_oauth_config;'::text);
  END IF;

  IF EXISTS (
    SELECT 1 FROM "github_config"
    WHERE "oauth_client_id" IS NOT NULL OR "oauth_client_secret_ciphertext" IS NOT NULL
  ) THEN
    found := array_append(found, 'GitHub sign-in (github_config.oauth_*) -> GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET; then: UPDATE github_config SET oauth_client_id = NULL, oauth_client_secret_ciphertext = NULL;'::text);
  END IF;

  IF EXISTS (
    SELECT 1 FROM "storage_config"
    WHERE "backend" <> 'inline'
       OR "s3_bucket" IS NOT NULL OR "s3_region" IS NOT NULL OR "s3_endpoint" IS NOT NULL
       OR "s3_prefix" IS NOT NULL OR "s3_force_path_style"
       OR "aws_access_key_id" IS NOT NULL OR "aws_secret_access_key_ciphertext" IS NOT NULL
  ) THEN
    found := array_append(found, 'Artifact storage (storage_config) -> ARTIFACT_S3_BUCKET, ARTIFACT_S3_REGION, ARTIFACT_S3_ENDPOINT, ARTIFACT_S3_PREFIX, ARTIFACT_S3_FORCE_PATH_STYLE, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY; then: DELETE FROM storage_config;'::text);
  END IF;

  IF EXISTS (
    SELECT 1 FROM "workflow_defaults"
    WHERE "workspace_memory" <> '4g' OR "workspace_cpus" <> 2
       OR "workspace_pids_limit" <> 512 OR "workspace_image" <> 'node:24-alpine'
  ) THEN
    found := array_append(found, 'Workspace sizing (workflow_defaults.workspace_*) -> WORKSPACE_MEMORY, WORKSPACE_CPUS, WORKSPACE_PIDS_LIMIT, WORKSPACE_IMAGE; then: UPDATE workflow_defaults SET workspace_memory = ''4g'', workspace_cpus = 2, workspace_pids_limit = 512, workspace_image = ''node:24-alpine'';'::text);
  END IF;

  IF EXISTS (
    SELECT 1 FROM "config_settings"
    WHERE "key" IN (
      'workspace.metadataBlockImage', 'workspace.blockMetadata',
      'workspace.maxConcurrentActivities', 'workspace.regexScanBudgetMs'
    )
  ) THEN
    found := array_append(found, 'Platform settings (config_settings) -> WORKSPACE_METADATA_BLOCK_IMAGE, WORKSPACE_BLOCK_METADATA, WORKER_MAX_CONCURRENT_ACTIVITIES, SCANNER_REGEX_BUDGET_MS; then: DELETE FROM config_settings WHERE key IN (''workspace.metadataBlockImage'', ''workspace.blockMetadata'', ''workspace.maxConcurrentActivities'', ''workspace.regexScanBudgetMs'');'::text);
  END IF;

  IF array_length(found, 1) IS NOT NULL THEN
    RAISE EXCEPTION E'Infrastructure config has moved from the admin UI to environment variables, and this database still holds values that would be lost. Set the variables, clear the rows, and re-run the migration:\n  - %', array_to_string(found, E'\n  - ');
  END IF;
END
$$;

DROP TABLE "google_oauth_config";
DROP TABLE "okta_oauth_config";
DROP TABLE "storage_config";

ALTER TABLE "github_config"
  DROP COLUMN "oauth_client_id",
  DROP COLUMN "oauth_client_secret_ciphertext",
  DROP COLUMN "oauth_client_secret_nonce",
  DROP COLUMN "oauth_client_secret_auth_tag",
  DROP COLUMN "oauth_client_secret_key_version",
  DROP COLUMN "oauth_client_secret_last_four";

ALTER TABLE "workflow_defaults"
  DROP COLUMN "workspace_memory",
  DROP COLUMN "workspace_cpus",
  DROP COLUMN "workspace_pids_limit",
  DROP COLUMN "workspace_image";
