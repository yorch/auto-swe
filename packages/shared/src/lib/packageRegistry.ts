/**
 * Workspace package-registries: which upstream npm registries (and their
 * credentials) apply to a workspace, and the precedence between global rows
 * and a team's own.
 *
 * The worker resolves this list when a workspace starts; the proxy fronts
 * every entry. The gateway CRUD writes the rows; this module is the pure part
 * both sides agree on.
 */

/** The ecosystems the registry proxy serves. */
export const PACKAGE_REGISTRY_ECOSYSTEMS = ['npm', 'go', 'pypi', 'maven'] as const;
export type PackageRegistryEcosystem = (typeof PACKAGE_REGISTRY_ECOSYSTEMS)[number];

/**
 * `'lockfile'`: only package@version pairs committed on the base ref resolve
 * through the proxy. `'open'`: anything the upstream serves does.
 */
export const PACKAGE_REGISTRY_ACCESS_MODES = ['lockfile', 'open'] as const;
export type PackageRegistryAccessMode = (typeof PACKAGE_REGISTRY_ACCESS_MODES)[number];

export const PACKAGE_REGISTRY_AUTH_KINDS = ['bearer', 'basic'] as const;
export type PackageRegistryAuthKind = (typeof PACKAGE_REGISTRY_AUTH_KINDS)[number];

/** The fields of a `PackageRegistry` row the resolution reads. */
export interface PackageRegistryLike {
  id: string;
  /** Absent means `npm`. */
  ecosystem?: string;
  isActive: boolean;
  npmScopes: string[];
  teamId: string | null;
}

export interface ResolvedRegistry<T extends PackageRegistryLike = PackageRegistryLike> {
  /** The row that won. */
  registry: T;
  /** Only the scopes this row *won* — a team row shadows a global row's scope. */
  scopes: string[];
  /** This row won the default (unscoped) key. */
  isDefault: boolean;
}

const DEFAULT_KEY = '';

/** The keys a registry row claims: one per scope, or the default key when it has none. */
function keysOf(row: PackageRegistryLike): string[] {
  return row.npmScopes.length > 0 ? row.npmScopes : [DEFAULT_KEY];
}

/**
 * The rows of one ecosystem (a row that names none is `npm`). Callers filter by
 * ecosystem *before* `resolvePackageRegistries`, so one ecosystem's rows never
 * shadow another's.
 *
 * Only npm has scopes. A `go` row has none, so it is a default-only registry:
 * `resolvePackageRegistries(registriesFor(rows, 'go'), teamId)` yields at most one
 * default, a team row beating a global one.
 */
export function registriesFor<T extends PackageRegistryLike>(
  rows: T[],
  ecosystem: PackageRegistryEcosystem
): T[] {
  return rows.filter((r) => (r.ecosystem ?? 'npm') === ecosystem);
}

/**
 * The registries that apply to a workspace of team `teamId` (or to every
 * team when it is null): active rows whose `teamId` is that team or null,
 * where for every claimed key — the default registry, then each scope — a
 * team row beats a global one. A row that loses every key it claimed is out.
 * Order is the input order.
 */
export function resolvePackageRegistries<T extends PackageRegistryLike>(
  rows: T[],
  teamId: string | null
): ResolvedRegistry<T>[] {
  const visible = rows.filter(
    (r) => r.isActive && (r.teamId === null || (teamId !== null && r.teamId === teamId))
  );
  const teamKeys = new Set(visible.filter((r) => r.teamId !== null).flatMap((r) => keysOf(r)));
  const out: ResolvedRegistry<T>[] = [];
  for (const registry of visible) {
    // A global row keeps only the keys no team row claimed; a team row keeps
    // all of its scopes. The default key is the same rule with `npmScopes: []`.
    const isDefault =
      registry.npmScopes.length === 0 && (registry.teamId !== null || !teamKeys.has(DEFAULT_KEY));
    const scopes =
      registry.teamId !== null
        ? registry.npmScopes
        : registry.npmScopes.filter((s) => !teamKeys.has(s));
    if (!isDefault && scopes.length === 0) {
      continue;
    }
    out.push({ isDefault, registry, scopes });
  }
  return out;
}

/** The default (unscoped) entry of a resolved list, if any. */
export function resolvedDefault<T extends PackageRegistryLike>(
  resolved: ResolvedRegistry<T>[]
): ResolvedRegistry<T> | undefined {
  return resolved.find((r) => r.isDefault);
}
