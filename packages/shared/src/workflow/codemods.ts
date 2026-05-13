/**
 * Built-in codemods registered at module load.
 *
 * Importing this module has the side effect of registering every spec
 * migration in order. The package barrel (./index.ts) imports it so any
 * consumer that uses `migrateSpec` automatically picks up the chain.
 *
 * Tests in `codemod.test.ts` bypass this file via `vi.resetModules()` to
 * exercise the registration machinery in isolation; production code paths
 * pull in the barrel and get the registered chain.
 */

import { registerCodemod } from './codemod.js';

/**
 * v1 → v2: Phase 2 introduces the optional `onFail` field on step nodes
 * (block | warn | { retry: N }). v1 specs have no `onFail` field and behave
 * as `block` by default, so the migration only needs to bump the version.
 * Existing `onError: 'continue'` semantics are preserved by the interpreter.
 */
registerCodemod({
  from: 1,
  to: 2,
  transform: (spec) => {
    const s = spec as Record<string, unknown>;
    return { ...s, schemaVersion: 2 };
  },
});

/**
 * v2 → v3: Phase 3 adds the `fanOut` node type. v2 specs without any `fanOut`
 * node are already valid under v3, so the transform only bumps the version.
 */
registerCodemod({
  from: 2,
  to: 3,
  transform: (spec) => {
    const s = spec as Record<string, unknown>;
    return { ...s, schemaVersion: 3 };
  },
});

/**
 * v3 → v4: Phase 6 adds the `shell` node type. v3 specs without any `shell`
 * node remain valid under v4, so the transform only bumps the version.
 */
registerCodemod({
  from: 3,
  to: 4,
  transform: (spec) => {
    const s = spec as Record<string, unknown>;
    return { ...s, schemaVersion: 4 };
  },
});
