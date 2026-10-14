/// Prisma's known unique-constraint error code. Used to detect lost-race
/// writes when two admins edit the same row simultaneously — partial unique
/// indexes from the Phase-1 migration enforce one row per (role,scope,key).
const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

/// Prisma's "record to update or delete does not exist" error code.
const RECORD_NOT_FOUND = 'P2025';

function hasPrismaCode(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}

export function isUniqueConstraintError(err: unknown): boolean {
  return hasPrismaCode(err, UNIQUE_CONSTRAINT_VIOLATION);
}

/** An `update`/`delete` whose `where` matched no row. */
export function isRecordNotFoundError(err: unknown): boolean {
  return hasPrismaCode(err, RECORD_NOT_FOUND);
}
