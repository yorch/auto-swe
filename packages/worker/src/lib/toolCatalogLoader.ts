import { prisma } from '@auto-swe/shared/db';
import {
  type ToolCatalogEntry,
  type ToolCatalogRow,
  ToolInstallError,
  toToolCatalogEntry,
} from '@auto-swe/shared/lib/toolCatalog';

/** How long a successful read is reused. A revocation lands within this window. */
export const TOOL_CATALOG_CACHE_MS = 30_000;

/** The slice of the Prisma client the loader reads, so a test can pass a fake. */
export interface ToolCatalogClient {
  toolCatalogEntry: { findMany: () => Promise<ToolCatalogRow[]> };
}

let cached: { at: number; entries: ToolCatalogEntry[] } | null = null;

/** Forget the memoised catalog (tests). */
export function resetToolCatalogCache(): void {
  cached = null;
}

/**
 * Every catalog row, parsed. The catalog is the allowlist, so this fails closed: a database error
 * is a retryable {@link ToolInstallError}, a row that does not validate is a non-retryable one,
 * and neither is ever answered from the built-in table (that would bypass a REVOKED row). Only a
 * successful read is memoised.
 */
export async function loadToolCatalog(
  client: ToolCatalogClient = prisma,
  now: number = Date.now()
): Promise<ToolCatalogEntry[]> {
  if (cached && now - cached.at < TOOL_CATALOG_CACHE_MS) {
    return cached.entries;
  }
  let rows: ToolCatalogRow[];
  try {
    rows = await client.toolCatalogEntry.findMany();
  } catch (err) {
    throw new ToolInstallError(
      `tool catalog is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: true }
    );
  }
  const entries = rows.map((row) => toToolCatalogEntry(row));
  cached = { at: now, entries };
  return entries;
}
