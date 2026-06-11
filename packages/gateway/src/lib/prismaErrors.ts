/// Prisma's known unique-constraint error code. Used to detect lost-race
/// writes when two admins edit the same row simultaneously — partial unique
/// indexes from the Phase-1 migration enforce one row per (role,scope,key).
const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

export function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === UNIQUE_CONSTRAINT_VIOLATION
  );
}
