/**
 * Step registry — the catalog of activity-backed steps that workflow specs
 * may reference. Activity wiring happens inside the workflow file (see
 * runnable.ts); this module only owns metadata used for:
 *
 *   - Editor UI (config fields, labels, descriptions)
 *   - Validation at template-write time (gateway)
 *   - Cost estimation
 *
 * Adding a new step:
 *   1. Implement the activity in packages/worker/src/activities/.
 *   2. Export it from activities/index.ts.
 *   3. Register a StepMetadata entry here.
 *   4. Add a dispatch case to dispatchStep() in workflows/runnable.ts.
 */

import type { StepMetadata } from '@auto-swe/shared/workflow';
import { BUILTIN_STEPS } from '@auto-swe/shared/workflow';

const REGISTRY = new Map<string, StepMetadata>();

function register(meta: StepMetadata): void {
  REGISTRY.set(meta.name, meta);
}

register({
  category: 'control',
  configFields: [
    {
      description: 'Domain status label written to ActiveWorkflow.currentStatus.',
      key: 'status',
      label: 'Status',
      required: true,
      type: 'string',
    },
  ],
  description: "Update the workflow row's currentStatus column.",
  label: 'Update domain state',
  name: 'updateDomainState',
});

register({
  category: 'agent',
  configFields: [],
  costHint: { role: 'validateContext', tokensIn: 4000, tokensOut: 500 },
  description: 'Extract success criteria from the work request payload.',
  label: 'Validate context',
  name: 'validateContext',
});

register({
  category: 'agent',
  configFields: [],
  costHint: { role: 'implementer', tokensIn: 20000, tokensOut: 8000 },
  description: 'Run the implementer agent inside a fresh Docker workspace.',
  label: 'Execute implementation',
  name: 'executeImplementation',
});

register({
  category: 'agent',
  configFields: [],
  costHint: { role: 'reviewer', tokensIn: 15000, tokensOut: 3000 },
  description: 'Run the security / domain / performance reviewer agents in parallel.',
  label: 'Run review network',
  name: 'runReviewNetwork',
});

register({
  category: 'agent',
  configFields: [],
  costHint: { role: 'implementer', tokensIn: 15000, tokensOut: 5000 },
  description: 'Re-run the implementer with reviewer rejection feedback.',
  label: 'Apply review fix',
  name: 'executeReviewFixImplementation',
});

register({
  category: 'agent',
  configFields: [],
  costHint: { role: 'implementer', tokensIn: 15000, tokensOut: 5000 },
  description: 'Re-run the implementer with CI failure logs as context.',
  label: 'Apply CI fix',
  name: 'executeCIFixImplementation',
});

register({
  category: 'vcs',
  configFields: [],
  description: 'Create or update the PR for this work request.',
  label: 'Create or update PR',
  name: 'createOrUpdatePullRequest',
});

register({
  category: 'control',
  configFields: [],
  description: 'Fetch and truncate CI logs from the given URL.',
  label: 'Fetch CI logs',
  name: 'fetchCILogs',
});

register({
  category: 'agent',
  configFields: [],
  costHint: { role: 'commitToMemory', tokensIn: 6000, tokensOut: 1000 },
  description: 'Summarize the run and store a lesson in pgvector memory.',
  label: 'Commit to memory',
  name: 'commitToMemory',
});

// ── Phase 2 — Quality gates ─────────────────────────────────────────────────
//
// Each gate accepts an optional `command` override and `timeoutMs`. The
// activity falls back through repo-level overrides (Repository.gateCommands)
// and the built-in defaults if a value is not supplied here.

const GATE_CONFIG_FIELDS = [
  {
    description:
      'Shell command run in the workspace. Overrides repo-level Repository.gateCommands and the built-in default.',
    key: 'command',
    label: 'Command',
    type: 'string' as const,
  },
  {
    description: 'Wall-clock limit for the gate run, in milliseconds. Defaults to 600000 (10 min).',
    key: 'timeoutMs',
    label: 'Timeout (ms)',
    type: 'number' as const,
  },
] as const;

register({
  category: 'gate',
  configFields: GATE_CONFIG_FIELDS,
  description: 'Run the repo lint command in the workspace and surface pass/fail.',
  label: 'Run lint',
  name: 'runLint',
});

register({
  category: 'gate',
  configFields: GATE_CONFIG_FIELDS,
  description: 'Run the repo typecheck command in the workspace.',
  label: 'Run typecheck',
  name: 'runTypecheck',
});

register({
  category: 'gate',
  configFields: GATE_CONFIG_FIELDS,
  description: 'Run the full test suite as a hard gate (separate from implementer TDD).',
  label: 'Run tests',
  name: 'runTests',
});

register({
  category: 'gate',
  configFields: GATE_CONFIG_FIELDS,
  description: 'Run the build command (e.g. yarn build) in the workspace.',
  label: 'Run build',
  name: 'runBuild',
});

register({
  category: 'gate',
  configFields: GATE_CONFIG_FIELDS,
  description: 'Run a vulnerability scan against the workspace dependencies.',
  label: 'Run vuln scan',
  name: 'runVulnScan',
});

register({
  category: 'gate',
  configFields: GATE_CONFIG_FIELDS,
  description: 'Run an operator-provided performance benchmark. No default command.',
  label: 'Run perf bench',
  name: 'runPerfBench',
});

register({
  category: 'agent',
  configFields: [],
  costHint: { role: 'implementer', tokensIn: 15000, tokensOut: 5000 },
  description: 'Re-run the implementer with a failed gate output as context.',
  label: 'Apply gate fix',
  name: 'executeGateFixImplementation',
});

// ── Phase 3 — Decomposition + branch merging ────────────────────────────────

register({
  category: 'agent',
  configFields: [],
  costHint: { role: 'planner', tokensIn: 6000, tokensOut: 2000 },
  description:
    'Split a work request into feature-level subtasks (one subagent per subtask). Returns { subtasks: Subtask[] }.',
  label: 'Plan decomposition',
  name: 'planDecomposition',
});

register({
  category: 'vcs',
  configFields: [
    {
      description: 'Prefix for each auto-generated merge commit message. Default: "auto-merge".',
      key: 'mergeMessagePrefix',
      label: 'Merge commit prefix',
      type: 'string',
    },
  ],
  description:
    'Merge N subtask branches into the parent feature branch. Aborts on conflict and reports which branch failed.',
  label: 'Merge branches',
  name: 'mergeBranches',
});

/** Get metadata for a step name. Throws on unknown step. */
export function getStepMetadata(name: string): StepMetadata {
  const meta = REGISTRY.get(name);
  if (!meta) throw new Error(`unknown step: ${name}`);
  return meta;
}

export function listSteps(): StepMetadata[] {
  return Array.from(REGISTRY.values());
}

export function hasStep(name: string): boolean {
  return REGISTRY.has(name);
}

/** Sanity check at worker startup: every BUILTIN_STEPS entry must be registered. */
export function assertBuiltinStepsRegistered(): void {
  const missing = BUILTIN_STEPS.filter((s) => !REGISTRY.has(s));
  if (missing.length) {
    throw new Error(`step registry is missing required builtins: ${missing.join(', ')}`);
  }
}
