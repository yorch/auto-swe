/**
 * Step registry — the catalog of step metadata that workflow specs may
 * reference. Lives in `shared` so the gateway can validate templates against
 * the catalog and the web editor can render the palette + per-node config
 * forms without pulling in worker-only code.
 *
 * Activity wiring still lives in the worker package (see
 * packages/worker/src/workflows/runnable.ts) — only the metadata is shared.
 *
 * Adding a new step:
 *   1. Implement the activity in packages/worker/src/activities/.
 *   2. Export it from activities/index.ts.
 *   3. Add the name to `BUILTIN_STEPS` in registry-types.ts.
 *   4. Register a StepMetadata entry here.
 *   5. Add an entry to the `STEP_EXECUTORS` map in workflows/runnable.ts
 *      (and to `STEP_REQUIRED_AGENTS` if the step resolves a model).
 *
 * The worker calls `assertBuiltinStepsRegistered()` at boot, and
 * `stepRequiredAgents.coverage.test.ts` checks `BUILTIN_STEPS` against the
 * executor table, so a step missing from either list fails before it ships.
 */

import { WORKSPACE_PROVIDER_TYPES } from '../lib/workspaceProviders.js';
import { BUILTIN_STEPS, type StepMetadata } from './registry-types.js';

const REGISTRY = new Map<string, StepMetadata>();

const SYSTEM_PROMPT_FIELD = {
  description:
    'Override the agent system prompt for this step. Leave empty to use the team/global default configured at /admin/model-config.',
  key: 'systemPrompt',
  label: 'System prompt',
  multiline: true,
  type: 'string' as const,
} as const;

export const IMPLEMENTER_TOOL_IDS = ['readFile', 'writeFile', 'listDirectory', 'bash'] as const;

/**
 * Pseudo tool-key (P2/WS2) that grants an Agent its MCP tools at run time. Not a
 * workspace tool — when present in an Agent's `toolKeys`, the run binds the tools
 * exposed by the referenced `mcp` server/Connection (see worker `loadMcpTools`).
 */
export const MCP_TOOL_KEY = 'mcp' as const;

/**
 * The full set of tool keys an Agent's `toolKeys` may contain: the four workspace
 * tools plus the `'mcp'` pseudo-key. Used to validate Agent tool config and to
 * populate the tool picker in the Agent library UI.
 */
export const AGENT_TOOL_KEYS = [...IMPLEMENTER_TOOL_IDS, MCP_TOOL_KEY] as const;
export type AgentToolKey = (typeof AGENT_TOOL_KEYS)[number];

/**
 * Cross-repo context injection (repo dependency graph, P2). The cheap tier
 * injects a bounded prompt block describing the repo's active 1-hop neighbours,
 * so it is on unless a template turns it off; the checkout tier clones those
 * upstream repos into the workspace, so it is opt-in.
 */
const CROSS_REPO_CONTEXT_FIELD = {
  description:
    'Inject the repo dependency graph (upstream contracts + downstream consumers) into the agent prompt. On by default; uncheck to omit it for this step.',
  key: 'crossRepoContext',
  label: 'Cross-repo dependency context',
  type: 'boolean' as const,
} as const;

const CROSS_REPO_CHECKOUT_FIELD = {
  description:
    'Also clone this repo\'s upstream dependencies read-only into /workspace/deps so the agent can read their source. Slower and more expensive — off by default. Requires "Cross-repo dependency context".',
  key: 'crossRepoCheckout',
  label: 'Check out upstream repos',
  type: 'boolean' as const,
} as const;

const IMPLEMENTER_TOOLS_FIELD = {
  description:
    'Tools available to the implementer agent. Leave empty to enable all tools (default). Uncheck a tool to restrict the agent from using it.',
  enumValues: IMPLEMENTER_TOOL_IDS,
  key: 'tools',
  label: 'Enabled tools',
  type: 'stringArray' as const,
} as const;

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
  configFields: [SYSTEM_PROMPT_FIELD],
  costHint: { role: 'validateContext', tokensIn: 4000, tokensOut: 500 },
  description: 'Extract success criteria from the work request payload.',
  label: 'Validate context',
  name: 'validateContext',
});

register({
  category: 'agent',
  configFields: [
    SYSTEM_PROMPT_FIELD,
    IMPLEMENTER_TOOLS_FIELD,
    CROSS_REPO_CONTEXT_FIELD,
    CROSS_REPO_CHECKOUT_FIELD,
  ],
  costHint: { role: 'implementer', tokensIn: 20000, tokensOut: 8000 },
  description: 'Run the implementer agent inside a fresh Docker workspace.',
  label: 'Execute implementation',
  name: 'executeImplementation',
});

register({
  category: 'agent',
  configFields: [SYSTEM_PROMPT_FIELD, CROSS_REPO_CONTEXT_FIELD],
  costHint: { role: 'reviewer', tokensIn: 15000, tokensOut: 3000 },
  description: 'Run the security / domain / performance reviewer agents in parallel.',
  label: 'Run review network',
  name: 'runReviewNetwork',
});

register({
  category: 'agent',
  configFields: [SYSTEM_PROMPT_FIELD, IMPLEMENTER_TOOLS_FIELD],
  costHint: { role: 'implementer', tokensIn: 15000, tokensOut: 5000 },
  description: 'Re-run the implementer with reviewer rejection feedback.',
  label: 'Apply review fix',
  name: 'executeReviewFixImplementation',
});

register({
  category: 'agent',
  configFields: [SYSTEM_PROMPT_FIELD, IMPLEMENTER_TOOLS_FIELD],
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

// ── CI wait strategy ─────────────────────────────────────────────────────────

register({
  category: 'control',
  configFields: [],
  description:
    'Read the CI wait strategy (webhook signal vs. active polling) from the workflow defaults. ' +
    'Returns { mode, intervalSec, graceSec, deadlineSec } for a downstream cond + poll step.',
  label: 'Resolve CI wait config',
  name: 'resolveCiWaitConfig',
});

register({
  category: 'gate',
  configFields: [
    {
      description:
        'Git ref (branch or SHA) whose CI status to poll. Defaults to context.currentCodeResult.branch.',
      key: 'ref',
      label: 'Ref',
      type: 'string',
    },
    {
      description: 'Seconds between status polls.',
      key: 'intervalSec',
      label: 'Poll interval (s)',
      type: 'number',
    },
    {
      description:
        'Seconds to wait for the first check run to appear before treating CI as absent.',
      key: 'graceSec',
      label: 'Grace period (s)',
      type: 'number',
    },
    {
      description: 'Seconds after which polling gives up and the step fails.',
      key: 'deadlineSec',
      label: 'Deadline (s)',
      type: 'number',
    },
  ],
  description:
    'Poll GitHub for the CI result of a ref instead of waiting for a webhook signal. ' +
    'Returns the same { passed, ... } payload the ciPipelineSignal carries.',
  label: 'Wait for CI (polling)',
  name: 'waitForCiByPolling',
});

register({
  category: 'agent',
  configFields: [SYSTEM_PROMPT_FIELD],
  costHint: { role: 'commitToMemory', tokensIn: 6000, tokensOut: 1000 },
  description: 'Summarize the run and store a lesson in pgvector memory.',
  label: 'Commit to memory',
  name: 'commitToMemory',
});

// ── Generic workspace / source / outcome / tool steps (non-SWE workflows) ──

register({
  category: 'control',
  configFields: [
    {
      description: 'Workspace provider this run targets. Defaults to the template provider.',
      enumValues: WORKSPACE_PROVIDER_TYPES,
      key: 'workspaceProvider',
      label: 'Workspace provider',
      type: 'enum',
    },
  ],
  description:
    'Materialise the workspace context (git repo, Notion page, Zendesk ticket, etc.) for a run.',
  label: 'Resolve workspace',
  name: 'resolveWorkspace',
});

register({
  category: 'control',
  configFields: [],
  description: 'Read a source object from the target connection (page, ticket, record, issue).',
  label: 'Read source',
  name: 'readSource',
});

register({
  category: 'control',
  configFields: [],
  description:
    'Write a validated outcome to the target connection (page, ticket, record, issue tracker, Slack).',
  label: 'Write outcome',
  name: 'writeOutcome',
});

register({
  category: 'control',
  configFields: [
    {
      description:
        'Risk class of the action being attempted (e.g. external_communication, external_write, internal_read).',
      key: 'action',
      label: 'Action risk class',
      type: 'string',
    },
  ],
  description:
    'Evaluate the autonomy policy for an external-facing action and decide whether to auto-publish or require approval.',
  label: 'Publish outcome',
  name: 'publishOutcome',
});

register({
  category: 'control',
  configFields: [],
  description: 'Run a named tool on a connection (e.g. fetchTicket, postMessage, createIssue).',
  label: 'Run connection tool',
  name: 'runTool',
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
  configFields: [SYSTEM_PROMPT_FIELD, IMPLEMENTER_TOOLS_FIELD],
  costHint: { role: 'implementer', tokensIn: 15000, tokensOut: 5000 },
  description: 'Re-run the implementer with a failed gate output as context.',
  label: 'Apply gate fix',
  name: 'executeGateFixImplementation',
});

// ── Phase 3 — Decomposition + branch merging ────────────────────────────────

register({
  category: 'agent',
  configFields: [SYSTEM_PROMPT_FIELD],
  costHint: { role: 'planner', tokensIn: 6000, tokensOut: 2000 },
  description:
    'Split a work request into feature-level subtasks (one subagent per subtask). Returns { subtasks: Subtask[] }.',
  label: 'Plan decomposition',
  name: 'planDecomposition',
});

register({
  category: 'agent',
  // systemPrompt overrides the decomposition planner prompt for this node.
  // costHint.role is a rough palette estimate; the activity runs on the channel's
  // channelAssistant model, whose opus-class default `reviewer` approximates (the
  // cheaper `planner` price would materially under-estimate it).
  configFields: [SYSTEM_PROMPT_FIELD],
  costHint: { role: 'reviewer', tokensIn: 2000, tokensOut: 800 },
  description:
    'Decompose a general channel task into 1..N independent subtasks. Returns { subtasks, subtaskCount }; returns a single subtask (the whole task) for cohesive work.',
  label: 'Plan channel task',
  name: 'planChannelTask',
});

register({
  category: 'agent',
  // systemPrompt overrides the SYNTHESIS prompt (the per-subtask branch runs use
  // the channel agent's own configured prompt). costHint.role is a rough palette
  // estimate; the activity runs on the channel's channelAssistant model, whose
  // opus-class default `reviewer` approximates.
  configFields: [SYSTEM_PROMPT_FIELD],
  costHint: { role: 'reviewer', tokensIn: 8000, tokensOut: 4000 },
  description:
    'Run each planned subtask through the channel assistant (bounded concurrency) and synthesize the partial answers into one reply. Returns { text }.',
  label: 'Run channel subtasks',
  name: 'runChannelSubtasks',
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

register({
  category: 'agent',
  configFields: [
    {
      description: 'Prefix for the merge commit produced after conflicts are resolved.',
      key: 'mergeMessagePrefix',
      label: 'Merge commit prefix',
      type: 'string',
    },
    {
      description:
        'How many resolver passes to run per conflicted branch before giving up. Default: 1.',
      key: 'maxAttemptsPerBranch',
      label: 'Max attempts per branch',
      type: 'number',
    },
    SYSTEM_PROMPT_FIELD,
    IMPLEMENTER_TOOLS_FIELD,
  ],
  costHint: { role: 'implementer', tokensIn: 12000, tokensOut: 4000 },
  description:
    'Run the implementer agent against conflict markers to resolve a failed merge in-place, then push.',
  label: 'Resolve merge conflict',
  name: 'resolveMergeConflict',
});

register({
  category: 'agent',
  configFields: [
    {
      description: 'Library Agent to run: "<key>" (latest) or "<key>@<version>" (pinned).',
      key: 'agentRef',
      label: 'Agent reference',
      required: true,
      type: 'string',
    },
    {
      description: 'Literal user message. Leave empty to pass the resolved node inputs as JSON.',
      key: 'userMessage',
      label: 'User message',
      multiline: true,
      type: 'string',
    },
    SYSTEM_PROMPT_FIELD,
  ],
  description: 'Run a library Agent by reference (the declarative agent node).',
  label: 'Run agent',
  name: 'runAgentNode',
});

// ── Executors behind the declarative eval / mcp / containerStep nodes ────────
//
// The interpreter packs each node's own fields into `config` and dispatches
// through the step path, so these appear here for validation, the palette and
// cost estimation; templates normally author the node type, not a `step`.

register({
  category: 'gate',
  configFields: [
    {
      description:
        'Scorer list: hard `gate`/`assert` scorers run first and short-circuit; `trajectory`/`judge` are advisory.',
      key: 'scorers',
      label: 'Scorers',
      required: true,
      type: 'json',
    },
    {
      description: 'The value under evaluation (the eval node binds this from `target`).',
      key: 'targetValue',
      label: 'Target value',
      type: 'json',
    },
    {
      description: 'When false, a calibrated judge axis may block the gate. Default: advisory.',
      key: 'judgeAdvisory',
      label: 'Judge is advisory',
      type: 'boolean',
    },
  ],
  costHint: { role: 'evalJudge', tokensIn: 6000, tokensOut: 800 },
  description:
    'Run eval scorers against a value and bind an aggregate score. The judge scorer is one evalJudge LLM call.',
  label: 'Run eval',
  name: 'runEvalNode',
});

register({
  category: 'control',
  configFields: [
    {
      description: 'Name of the active `mcp` Connection whose server exposes the tool.',
      key: 'connectionRef',
      label: 'MCP connection',
      required: true,
      type: 'string',
    },
    {
      description: 'Tool name as listed by the MCP server.',
      key: 'tool',
      label: 'Tool',
      required: true,
      type: 'string',
    },
  ],
  description: 'Call one tool on an external MCP server with the resolved inputs as arguments.',
  label: 'Call MCP tool',
  name: 'mcpCallTool',
});

register({
  category: 'shell',
  configFields: [
    {
      description: 'Container image to run (must be on the shell image allowlist).',
      key: 'image',
      label: 'Image',
      required: true,
      type: 'string',
    },
    {
      description: 'Command to run in the container. Defaults to the image entrypoint.',
      key: 'command',
      label: 'Command',
      type: 'string',
    },
    {
      description: 'Network mode. `none` (default) or `egress`.',
      enumValues: ['none', 'egress'],
      key: 'network',
      label: 'Network',
      type: 'enum',
    },
    {
      description:
        'How the step returns its result: JSON on stdout, NDJSON stream, or a sidecar HTTP request.',
      enumValues: ['stdout', 'ndjson', 'sidecar'],
      key: 'transport',
      label: 'Transport',
      type: 'enum',
    },
    { description: 'Memory cap, e.g. "1g".', key: 'memory', label: 'Memory', type: 'string' },
    { description: 'CPU cap.', key: 'cpus', label: 'CPUs', type: 'number' },
    {
      description: 'Wall-clock limit for the container run, in milliseconds.',
      key: 'timeoutMs',
      label: 'Timeout (ms)',
      type: 'number',
    },
  ],
  description:
    'Run a container-contract coded step: an ephemeral image with the inputs as JSON env, output parsed from stdout.',
  label: 'Run container step',
  name: 'runContainerStep',
});

// ── PRD decomposition workflow ───────────────────────────────────────────────

register({
  category: 'agent',
  configFields: [SYSTEM_PROMPT_FIELD],
  costHint: { role: 'planner', tokensIn: 8000, tokensOut: 1500 },
  description:
    'Analyse a PRD document for engineering readiness: gaps, ambiguities, missing NFRs. ' +
    'Returns { summary, readiness, gaps }.',
  label: 'Analyse PRD',
  name: 'analyzePrd',
});

register({
  category: 'agent',
  configFields: [SYSTEM_PROMPT_FIELD],
  costHint: { role: 'planner', tokensIn: 12000, tokensOut: 3000 },
  description:
    'Decompose a PRD (plus optional PM feedback) into epics and stories with acceptance criteria. ' +
    'Returns { rationale, epics }.',
  label: 'Decompose PRD',
  name: 'decomposePrd',
});

register({
  category: 'control',
  configFields: [],
  description:
    'Best-effort creation of epics and stories in the configured tracker (Jira / Linear / GitHub Issues). ' +
    'Uses onFail: warn so a tracker outage never blocks the implementation queue.',
  label: 'Create tracker items',
  name: 'createTrackerItems',
});

register({
  category: 'control',
  configFields: [],
  description:
    'Submit each approved story as a separate implementation work request, ' +
    'starting a RunnableWorkflow per story. Returns { workRequestIds }.',
  label: 'Submit PRD work requests',
  name: 'submitPrdWorkRequests',
});

/** Get metadata for a step name. Throws on unknown step. */
export function getStepMetadata(name: string): StepMetadata {
  const meta = REGISTRY.get(name);
  if (!meta) {
    throw new Error(`unknown step: ${name}`);
  }
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
