/**
 * The `packageManager` pin of a `package.json`, as the npm package it names.
 *
 * Kept apart from `lockfileAllowlist.ts` because that module imports `yaml`,
 * and `stackDetection.ts` (which the web bundle imports) needs only this.
 */

export interface LockedPackage {
  name: string;
  version: string;
}

/**
 * The package-manager pin a `package.json` `packageManager` field declares, as
 * the npm package Corepack would download for it: `pnpm@v` → `pnpm`, Yarn
 * classic → `yarn`, Yarn ≥2 (Berry) → `@yarnpkg/cli-dist`, `npm@v` → `npm`.
 * Adding these to the lockfile allowlist lets Corepack fetch the pinned
 * binaries through the proxy. Anything unparsable contributes nothing.
 */
export function packageManagerPins(packageJsonContent: string): LockedPackage[] {
  let field: unknown;
  try {
    field = (JSON.parse(packageJsonContent) as { packageManager?: unknown }).packageManager;
  } catch {
    return [];
  }
  const m = typeof field === 'string' ? /^(npm|pnpm|yarn)@(\d[^+\s]*)(\+\S+)?$/.exec(field) : null;
  if (!m) {
    return [];
  }
  const [, pm, version] = m;
  if (pm === 'yarn' && Number(version?.split('.')[0]) >= 2) {
    return [{ name: '@yarnpkg/cli-dist', version: version ?? '' }];
  }
  return [{ name: pm ?? '', version: version ?? '' }];
}
