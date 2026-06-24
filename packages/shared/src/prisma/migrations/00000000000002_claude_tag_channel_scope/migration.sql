-- ----------------------------------------------------------------------------
-- Claude Tag: add the CHANNEL value to the ConfigScope enum.
--
-- Kept in its own migration: Postgres forbids using a freshly-added enum value
-- in the same transaction that adds it (the value referenced by the partial
-- index + CHECK constraints in 00000000000003 must already be committed).
-- ----------------------------------------------------------------------------

ALTER TYPE "ConfigScope" ADD VALUE IF NOT EXISTS 'CHANNEL';
