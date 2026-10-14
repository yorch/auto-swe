/**
 * Auditable subset of an API token row — a person's or a service principal's.
 * Never includes the plaintext token or the stored sha-256 hash — the audit log
 * only needs identity and lifecycle metadata. Shared by the self-service token
 * routes, the service principal routes and the admin revocation route so they
 * can never disagree about what reaches the log.
 */
export function safePatAuditFields(row: {
  expiresAt?: Date | null;
  id: string;
  name: string;
  prefix: string;
  revokedAt?: Date | null;
  userId: string | null;
  servicePrincipalId?: string | null;
  scopes?: string[];
}): Record<string, unknown> {
  return {
    expiresAt: row.expiresAt ?? null,
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    revokedAt: row.revokedAt ?? null,
    userId: row.userId,
    ...(row.servicePrincipalId
      ? { scopes: row.scopes ?? [], servicePrincipalId: row.servicePrincipalId }
      : {}),
  };
}

/** The audit entity a token row is recorded under. */
export function tokenAuditEntity(row: {
  servicePrincipalId?: string | null;
}): 'PersonalAccessToken' | 'ServiceToken' {
  return row.servicePrincipalId ? 'ServiceToken' : 'PersonalAccessToken';
}
