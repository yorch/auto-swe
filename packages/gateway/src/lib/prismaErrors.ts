/// Prisma's known unique-constraint error code. Used to detect lost-race
/// writes when two admins edit the same row simultaneously — partial unique
/// indexes from the Phase-1 migration enforce one row per (role,scope,key).
const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

/// Prisma's "record to update or delete does not exist" error code.
const RECORD_NOT_FOUND = 'P2025';

/// A CHECK constraint the engine reports itself, and the code Prisma gives any other database
/// error that a driver adapter passes through (`pg` does not map a check violation).
const CONSTRAINT_FAILED = 'P2004';
const DRIVER_ADAPTER_ERROR = 'P2039';
/// Postgres SQLSTATE `check_violation`.
const PG_CHECK_VIOLATION = '23514';

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

/** A write refused by a CHECK constraint, however the engine or the driver adapter reports it. */
export function isCheckConstraintError(err: unknown): boolean {
  if (hasPrismaCode(err, CONSTRAINT_FAILED)) {
    return true;
  }
  if (!hasPrismaCode(err, DRIVER_ADAPTER_ERROR)) {
    return false;
  }
  const meta = (err as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } })
    .meta;
  return meta?.driverAdapterError?.cause?.originalCode === PG_CHECK_VIOLATION;
}
