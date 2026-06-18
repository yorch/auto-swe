/**
 * Built-in codemods registered at module load.
 *
 * Importing this module has the side effect of registering every spec
 * migration in order; the package barrel (./index.ts) imports it so any
 * consumer that uses `migrateSpec` automatically picks up the chain.
 *
 * The schema is currently at its **v1 baseline**: the pre-deployment version
 * history (v1→v5) was collapsed because nothing was ever deployed at an older
 * `schemaVersion`, so there are no stored specs to migrate and no built-in
 * codemods to register. When `SPEC_SCHEMA_VERSION` next bumps, register a
 * `{ from, to, transform }` here via `registerCodemod` (see codemod.ts) and the
 * barrel-imported chain is picked up automatically. The registration machinery
 * itself is covered by `codemod.test.ts`.
 */

export {};
