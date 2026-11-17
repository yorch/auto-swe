-- Data only. better-auth stores on every dynamically registered client the scopes the server
-- knew when it registered, so a client registered before `mcp:admin` existed holds
-- {mcp:read, mcp:write, offline_access} and `authorize` answers invalid_scope the moment it asks
-- for the new scope. Append it to those clients. The user's consent row stays the ceiling on what
-- a token carries, and a fresh registration would store it anyway. A client that registered for
-- less (no `mcp:write`) is left alone, and the guard makes a second run change nothing.
UPDATE "oauth_clients"
SET "scopes" = array_append("scopes", 'mcp:admin')
WHERE 'mcp:read' = ANY("scopes")
  AND 'mcp:write' = ANY("scopes")
  AND NOT ('mcp:admin' = ANY("scopes"));
