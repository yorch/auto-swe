-- `connections.github_url` / `github_api_url` are HOST overrides: the web base
-- and API base the platform's GitHub credential is sent to for that repository.
-- An older import path stored per-repository URLs in them instead
-- (`https://github.com/acme/api`, `https://ghe.example.com/api/v3/repos/acme/api`).
-- The write path now accepts only a bare host (plus `/api/v3` on an API base),
-- so every edit of such a row was refused with 400 INVALID_GITHUB_HOST even when
-- the form re-sent the stored value unchanged.
--
-- Normalise them to the shape the write path stores: `scheme://host[:port]`,
-- keeping a leading `/api/v3` on the API base. The repository identity is not
-- lost — it lives in `organization_name` / `repo_name`.
--
-- Idempotent: an already-normalised value maps to itself, and the WHERE clauses
-- touch only rows whose value would change. A value that is not an
-- http(s) URL at all is left alone; the write path still rejects it, which is
-- the right outcome for a value this migration cannot interpret.

UPDATE "connections"
SET "github_url" = regexp_replace("github_url", '^(https?://[^/?#]+).*$', '\1')
WHERE "github_url" ~ '^https?://[^/?#]+'
  AND "github_url" <> regexp_replace("github_url", '^(https?://[^/?#]+).*$', '\1');

UPDATE "connections"
SET "github_api_url" = regexp_replace(
  "github_api_url",
  '^(https?://[^/?#]+)(/api/v3(?=[/?#]|$))?.*$',
  '\1\2'
)
WHERE "github_api_url" ~ '^https?://[^/?#]+'
  AND "github_api_url" <> regexp_replace(
    "github_api_url",
    '^(https?://[^/?#]+)(/api/v3(?=[/?#]|$))?.*$',
    '\1\2'
  );
