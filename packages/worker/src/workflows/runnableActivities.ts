/**
 * Activity proxies for `RunnableWorkflow`'s dispatcher and step executors.
 *
 * Isolate-safe: creating a proxy is deterministic and emits no command, so these
 * are built once at module load inside the workflow bundle. The policies mirror
 * the ones the hardcoded engineering workflow used.
 */

import { proxyActivities } from '@temporalio/workflow';
import type * as activitiesType from '../activities/index.js';
import {
  RETRY_AGENT,
  RETRY_LLM_LIGHT,
  RETRY_SANDBOX,
  RETRY_SINGLE_ATTEMPT,
  RETRY_STANDARD,
  RETRY_STATE,
  T_1M,
  T_2M,
  T_5M,
  T_10M,
  T_15M,
  T_30M,
  T_30S,
  T_60M,
  T_AGENT_RUN_ACTIVITY,
} from './proxyOptions.js';

export const stateActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    | 'updateDomainState'
    | 'createWorkflowRun'
    | 'recordWorkflowStep'
    | 'finalizeWorkflowRun'
    | 'createHumanStep'
    | 'resolveHumanStep'
    | 'cancelPendingHumanSteps'
    | 'storeContextOverflowBatch'
  >
>({
  retry: RETRY_STATE,
  startToCloseTimeout: T_30S,
});

export const genericActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    'resolveWorkspace' | 'readSource' | 'writeOutcome' | 'publishOutcome' | 'runTool'
  >
>({
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_1M,
});

export const agentActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    | 'executeImplementation'
    | 'executeCIFixImplementation'
    | 'executeReviewFixImplementation'
    | 'executeGateFixImplementation'
    | 'planDecomposition'
    | 'runChannelSubtasks'
    | 'runReviewNetwork'
  >
>({
  heartbeatTimeout: T_5M,
  retry: RETRY_AGENT,
  startToCloseTimeout: T_30M,
});

export const mergeActivities = proxyActivities<Pick<typeof activitiesType, 'mergeBranches'>>({
  heartbeatTimeout: T_5M,
  retry: {
    backoffCoefficient: 2,
    initialInterval: '5s',
    maximumAttempts: 2,
    maximumInterval: '1m',
  },
  startToCloseTimeout: T_15M,
});

// Conflict resolution is implementer-bound (one or more LLM calls per branch);
// share the long-lived agent timeouts rather than the cheaper merge proxy.
export const conflictActivities = proxyActivities<
  Pick<typeof activitiesType, 'resolveMergeConflict'>
>({
  heartbeatTimeout: T_5M,
  retry: RETRY_AGENT,
  startToCloseTimeout: T_30M,
});

// User-authored shell steps. `runShellStep` runs the command via async spawn
// with heartbeat pumping; `startToCloseTimeout` still caps the wall clock (the
// activity's own cap is `timeoutMs`, set on the shell node). The heartbeat
// timeout is what notices a worker that died mid-step — without it Temporal
// waited out the full hour — and is how a cancellation reaches the step.
export const shellActivities = proxyActivities<Pick<typeof activitiesType, 'runShellStep'>>({
  heartbeatTimeout: T_5M,
  retry: RETRY_SANDBOX,
  startToCloseTimeout: T_60M,
});

// P4/WS4: container-contract coded steps. Same sandbox/lifecycle shape as shell.
export const containerStepActivities = proxyActivities<
  Pick<typeof activitiesType, 'runContainerStep'>
>({
  heartbeatTimeout: T_5M,
  retry: RETRY_SANDBOX,
  startToCloseTimeout: T_60M,
});

// Quality gates: shell-bound, fail-by-exit-code. Temporal-level retries are
// kept low — workflow-level retry/warn/block comes from the spec's onFail
// policy (handled by the interpreter), not the activity proxy.
export const gateActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    'runLint' | 'runTypecheck' | 'runTests' | 'runBuild' | 'runVulnScan' | 'runPerfBench'
  >
>({
  heartbeatTimeout: T_2M,
  retry: RETRY_SANDBOX,
  startToCloseTimeout: T_15M,
});

export const githubActivities = proxyActivities<
  Pick<typeof activitiesType, 'createOrUpdatePullRequest' | 'fetchCILogs'>
>({
  retry: {
    backoffCoefficient: 3,
    initialInterval: '5s',
    maximumAttempts: 4,
    maximumInterval: '2m',
  },
  startToCloseTimeout: T_2M,
});

// CI triage: a few GitHub reads, one structured LLM call on the logs, and a PR comment.
// Retried like any LLM step; the invalid-payload and refused-run failures are
// non-retryable ApplicationFailures, which the policy does not retry.
export const ciTriageActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    'triageCiFailure' | 'reportCiTriage' | 'pushCiFixToPullRequest' | 'finishCiFixPush'
  >
>({
  heartbeatTimeout: T_2M,
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_10M,
});

// Verifying a CI fix: two runs of the reproduction command in one workspace, each bounded at
// ten minutes, plus a clone. Retried like a gate.
export const ciVerifyActivities = proxyActivities<Pick<typeof activitiesType, 'verifyCiFix'>>({
  heartbeatTimeout: T_2M,
  retry: RETRY_SANDBOX,
  startToCloseTimeout: T_30M,
});

// Lists provider models through the GLOBAL credentials. Provider calls inside are
// bounded at 10 s a page, so the timeout is generous; the precondition failures are
// non-retryable ApplicationFailures, which the policy does not retry.
export const catalogActivities = proxyActivities<Pick<typeof activitiesType, 'listProviderModels'>>(
  {
    retry: RETRY_STANDARD,
    startToCloseTimeout: T_5M,
  }
);

export const contextActivities = proxyActivities<Pick<typeof activitiesType, 'validateContext'>>({
  heartbeatTimeout: T_2M,
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_5M,
});

export const memoryActivities = proxyActivities<Pick<typeof activitiesType, 'commitToMemory'>>({
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_5M,
});

// P2: declarative agent node. Tool-free single-shot agent run; same retry shape
// as the other LLM activities. `planChannelTask` (general-route decomposition
// planner) is the same shape — a single-shot structured LLM call.
export const agentNodeActivities = proxyActivities<
  Pick<typeof activitiesType, 'runAgentNode' | 'planChannelTask'>
>({
  heartbeatTimeout: T_2M,
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_10M,
});

// The same activity for an `agent` node that asks for a workspace: it clones the
// run's repository and may run a whole harness turn, so it takes the implementer's
// timeouts and retry shape, not a single-shot call's. The node's own
// `startToCloseTimeout` is not read (validateSpec reports it as ignored).
export const agentNodeWorkspaceActivities = proxyActivities<
  Pick<typeof activitiesType, 'runAgentNode'>
>({
  heartbeatTimeout: T_5M,
  retry: RETRY_AGENT,
  startToCloseTimeout: T_30M,
});

// The Agent Run system template's step: a workspace container, an agent loop of
// up to the platform's wall-clock ceiling (max 4 h), then a trusted-container
// gate and push. Single attempt, because a retry would re-spend and could
// re-publish; `startToCloseTimeout` is only a backstop (the real bound is the
// per-run deadline inside the activity). It is derived from the setting's hard
// maximum plus a documented headroom for the clone, export, scan and push around
// the loop (see `T_AGENT_RUN_ACTIVITY` in proxyOptions.ts).
export const agentTaskActivities = proxyActivities<Pick<typeof activitiesType, 'runAgentTask'>>({
  heartbeatTimeout: T_5M,
  retry: RETRY_SINGLE_ATTEMPT,
  startToCloseTimeout: T_AGENT_RUN_ACTIVITY,
});

// Evals P2: declarative `eval` node. Runs scorers (assert/trajectory + judge
// LLM call), so it gets the longer agent-style timeout.
export const evalNodeActivities = proxyActivities<Pick<typeof activitiesType, 'runEvalNode'>>({
  heartbeatTimeout: T_2M,
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_10M,
});

// P2/WS4: declarative mcp node. Single external MCP tool call (network I/O in
// the activity); heartbeat + retry like the other network activities.
export const mcpNodeActivities = proxyActivities<Pick<typeof activitiesType, 'mcpCallTool'>>({
  heartbeatTimeout: T_2M,
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_10M,
});

// CI-wait config resolution — a quick DB read, same shape as the other config
// activities.
export const ciConfigActivities = proxyActivities<
  Pick<typeof activitiesType, 'resolveCiWaitConfig'>
>({
  retry: RETRY_STANDARD,
  startToCloseTimeout: T_1M,
});

// CI polling — a long-running activity that self-bounds by its `deadlineSec`
// input and heartbeats each tick. `startToCloseTimeout` must exceed the largest
// configurable deadline (default 4h); no Temporal-level retry — the poll loop
// already tolerates transient fetch errors, and a deadline is terminal.
export const ciPollActivities = proxyActivities<Pick<typeof activitiesType, 'waitForCiByPolling'>>({
  heartbeatTimeout: T_2M,
  retry: RETRY_SINGLE_ATTEMPT,
  startToCloseTimeout: '6h',
});

// PRD decomposition workflow steps. analyzePrd + decomposePrd call LLM agents
// (heartbeat + generous timeout); createTrackerItems + submitPrdWorkRequests
// make external HTTP calls (shorter timeout; no heartbeat needed).
export const prdActivities = proxyActivities<
  Pick<
    typeof activitiesType,
    'analyzePrd' | 'decomposePrd' | 'createTrackerItems' | 'submitPrdWorkRequests'
  >
>({
  heartbeatTimeout: T_5M,
  retry: RETRY_LLM_LIGHT,
  startToCloseTimeout: T_15M,
});
