/**
 * The largest value a Postgres `integer` column (Prisma `Int`) holds. A request
 * field stored in one needs this as its `.max()`: a larger number passes Zod's
 * `.int()` and fails at the database as a 500 instead of a 400.
 */
export const PG_INT_MAX = 2_147_483_647;
