-- Supports reports that scan agent_traces by time window: the platform usage
-- report, security events (newest first), and skill effectiveness.
--
-- CONCURRENTLY so building it does not block trace inserts on a large table.
-- It cannot run inside a transaction, which is why it is the only statement in
-- this migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_traces_created_at_idx" ON "agent_traces"("created_at");
