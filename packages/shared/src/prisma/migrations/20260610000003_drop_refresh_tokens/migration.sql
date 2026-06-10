-- ARCH-4: full auth consolidation. The legacy bcrypt /auth/login +
-- refresh-token-family flow is removed; browser sign-in goes through
-- better-auth sessions and programmatic access uses personal access tokens.
DROP TABLE IF EXISTS "refresh_tokens";
