-- Captured when a user links a GitHub identity. GitHub's collaborator-permission
-- endpoint addresses a user by login, and better-auth records only the numeric
-- account id on `accounts.account_id`, so the repository-permission projection
-- needs the login stored here rather than translated on every lookup.
--
-- Unique: one GitHub identity must not map to two platform users, or the
-- projection would grant one user's repository access to the other.
ALTER TABLE "users" ADD COLUMN "github_login" TEXT;

CREATE UNIQUE INDEX "users_github_login_key" ON "users"("github_login");
