/**
 * Auditable subset of a personal access token row. Never includes the plaintext
 * token or the stored sha-256 hash — the audit log only needs identity and
 * lifecycle metadata. Shared by the self-service token routes and the admin
 * revocation route so the two can never disagree about what reaches the log.
 */
export function safePatAuditFields(row: {
  expiresAt?: Date | null;
  id: string;
  name: string;
  prefix: string;
  revokedAt?: Date | null;
  userId: string;
}): Record<string, unknown> {
  return {
    expiresAt: row.expiresAt ?? null,
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    revokedAt: row.revokedAt ?? null,
    userId: row.userId,
  };
}
