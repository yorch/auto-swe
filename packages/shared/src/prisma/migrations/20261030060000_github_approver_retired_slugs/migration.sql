-- Slugs of approver Apps that were removed or replaced. An approval such an App gave stays on a
-- pull request until it is dismissed, and its reviews are recognised only by `<slug>[bot]`, so the
-- slug is kept (never a key) for the withdrawal to name it. Empty for every existing row.
ALTER TABLE "github_approver_app" ADD COLUMN "retired_app_slugs" TEXT[] NOT NULL DEFAULT '{}';
