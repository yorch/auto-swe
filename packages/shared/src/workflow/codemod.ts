/**
 * Codemod harness — migrates stored WorkflowSpec JSON across schema versions.
 *
 * When SPEC_SCHEMA_VERSION bumps, register a transform here that takes the
 * previous-version JSON and returns the next-version JSON. The harness
 * chains them so an old template stored at v1 can be auto-rewritten to vN.
 *
 * Phase 1 has only schemaVersion=1, so no transforms are needed yet. The
 * machinery is in place so adding v2 later is a single registration.
 */

export type Codemod = {
  from: number;
  to: number;
  /** Transforms an arbitrary JSON blob asserted at version `from` into one at version `to`. */
  transform: (spec: unknown) => unknown;
};

const codemods: Codemod[] = [];

/** Register a codemod. Throws if a codemod for the same `from` version exists. */
export function registerCodemod(mod: Codemod): void {
  if (codemods.find((c) => c.from === mod.from)) {
    throw new Error(`codemod from version ${mod.from} already registered`);
  }
  if (mod.to !== mod.from + 1) {
    throw new Error(`codemod must bump by exactly one (got ${mod.from} -> ${mod.to})`);
  }
  codemods.push(mod);
}

/**
 * Apply codemods in order until reaching `targetVersion`.
 *
 * Contract: this validates only that each transform output is a versioned
 * object at the expected `schemaVersion` — it does NOT validate the result
 * against `WorkflowSpecSchema`. Callers MUST run `parseWorkflowSpec` on the
 * output before treating it as a `WorkflowSpec` (the runtime consumer in
 * `worker/activities/templates.ts` does). A future structural codemod that
 * returns a malformed blob will therefore surface at that parse, not here.
 */
export function migrateSpec(input: unknown, targetVersion: number): unknown {
  if (!isVersionedObject(input)) {
    throw new Error('spec is missing schemaVersion');
  }
  let cur: { schemaVersion: number } & Record<string, unknown> = input;
  while (cur.schemaVersion < targetVersion) {
    const mod = codemods.find((c) => c.from === cur.schemaVersion);
    if (!mod) {
      throw new Error(`no codemod registered for schemaVersion ${cur.schemaVersion}`);
    }
    const next = mod.transform(cur);
    if (!isVersionedObject(next) || next.schemaVersion !== mod.to) {
      throw new Error(
        `codemod from ${mod.from} returned invalid output (expected schemaVersion=${mod.to})`
      );
    }
    cur = next;
  }
  return cur;
}

function isVersionedObject(x: unknown): x is { schemaVersion: number } & Record<string, unknown> {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as Record<string, unknown>).schemaVersion === 'number'
  );
}
