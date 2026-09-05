/**
 * Step registry — shared types for steps that can appear in WorkflowSpec nodes.
 *
 * The metadata registry lives next door in `stepRegistry.ts`; the activity
 * wiring is the worker's `STEP_EXECUTORS` table (packages/worker/src/workflows/
 * runnable.ts). Web + gateway only need the metadata to render the editor UI
 * and validate templates.
 */

export type StepCategory = 'agent' | 'gate' | 'control' | 'vcs' | 'shell';

export interface StepFieldDef {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'json' | 'stringArray';
  enumValues?: readonly string[];
  required?: boolean;
  default?: unknown;
  description?: string;
  /** When true, NodeConfigForm renders a <textarea> instead of <input type="text">. */
  multiline?: boolean;
}

export interface StepMetadata {
  name: string;
  category: StepCategory;
  label: string;
  description: string;
  /** Config fields exposed in the UI editor. */
  configFields: readonly StepFieldDef[];
  /** Approximate per-call token usage for cost estimation (optional). */
  costHint?: {
    role?:
      | 'implementer'
      | 'reviewer'
      | 'planner'
      | 'securityReview'
      | 'validateContext'
      | 'commitToMemory'
      | 'evalJudge';
    tokensIn?: number;
    tokensOut?: number;
  };
}

/** Canonical list of step names registered by the worker. Validated at startup. */
export const BUILTIN_STEPS = [
  // Agent + control-flow + version-control steps
  'updateDomainState',
  'validateContext',
  'executeImplementation',
  'runReviewNetwork',
  'executeReviewFixImplementation',
  'executeCIFixImplementation',
  'createOrUpdatePullRequest',
  'fetchCILogs',
  // CI wait strategy: resolve signal-vs-poll config, then poll when configured
  'resolveCiWaitConfig',
  'waitForCiByPolling',
  'commitToMemory',
  // Quality gates + the gate-fix loop
  'runLint',
  'runTypecheck',
  'runTests',
  'runBuild',
  'runVulnScan',
  'runPerfBench',
  'executeGateFixImplementation',
  // Feature decomposition + branch merging (used by fan-out)
  'planDecomposition',
  'mergeBranches',
  // General-route channel-task decomposition (plan → cond → single | composite)
  'planChannelTask',
  'runChannelSubtasks',
  // Implementer-driven merge-conflict resolution
  'resolveMergeConflict',
  // Declarative agent node — runs a library Agent by reference
  'runAgentNode',
  // Executors behind the declarative eval / mcp / containerStep nodes
  'runEvalNode',
  'mcpCallTool',
  'runContainerStep',
  // PRD decomposition workflow steps
  'analyzePrd',
  'decomposePrd',
  'createTrackerItems',
  'submitPrdWorkRequests',
  // Generic workspace / source / outcome / tool steps for non-SWE workflows
  'resolveWorkspace',
  'readSource',
  'writeOutcome',
  'publishOutcome',
  'runTool',
] as const;
export type BuiltinStepName = (typeof BUILTIN_STEPS)[number];
