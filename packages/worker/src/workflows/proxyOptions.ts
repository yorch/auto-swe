import type { Duration, RetryPolicy } from '@temporalio/common';

/**
 * Shared `proxyActivities` option presets for the worker's workflow files.
 *
 * These are the recurring retry-policy shapes and timeout tiers that were
 * previously declared inline (and duplicated) across every workflow module.
 * Centralising them keeps the many `proxyActivities<…>({ … })` call sites
 * honest about which policy they share, without changing a single effective
 * option value.
 *
 * V8-isolate safety: this module exports ONLY plain object/string literals and
 * uses `import type` (fully erased) for the two Temporal helper types. It has no
 * runtime imports of Node built-ins or external packages, so it is safe to
 * runtime-`import` from a workflow file that runs in the Temporal V8 isolate —
 * exactly like the other pure local modules the workflows already import
 * (`taskChild.js`, the shared interpreter, `signalSlots`, …).
 *
 * Naming: retry presets are named by role; timeout constants are named by their
 * literal duration string (`T_<value>`) so a reviewer can verify at a glance
 * that no value changed. The short-form (`'30m'`) and long-form (`'30 minutes'`)
 * literals are deliberately kept as SEPARATE constants — the two spellings were
 * used verbatim in different files and are preserved exactly (Temporal parses
 * them identically, but the source string is left untouched).
 */

// ── Retry policies ──────────────────────────────────────────────────────────

/**
 * 3 attempts, 5s → 1m backoff. The default LLM / config / network retry shape.
 * `{ backoffCoefficient: 2, initialInterval: '5s', maximumAttempts: 3, maximumInterval: '1m' }`
 * Used by: validateContext, commitToMemory, runAgentNode/planChannelTask,
 * runEvalNode, mcpCallTool, resolveCiWaitConfig (runnable); planEpic (epic);
 * runChannelAssistantTurn (channelAssistant).
 */
export const RETRY_STANDARD = {
  backoffCoefficient: 2,
  initialInterval: '5s',
  maximumAttempts: 3,
  maximumInterval: '1m',
} satisfies RetryPolicy;

/**
 * 5 attempts, 1s → 30s backoff. Durable domain/run state writes that should try
 * hard to land.
 * `{ backoffCoefficient: 2, initialInterval: '1s', maximumAttempts: 5, maximumInterval: '30s' }`
 * Used by: stateActivities (runnable, epicOrchestrator).
 */
export const RETRY_STATE = {
  backoffCoefficient: 2,
  initialInterval: '1s',
  maximumAttempts: 5,
  maximumInterval: '30s',
} satisfies RetryPolicy;

/**
 * 2 attempts, 30s → 2m backoff. Long-lived implementer/LLM activities where a
 * retry is expensive.
 * `{ backoffCoefficient: 2, initialInterval: '30s', maximumAttempts: 2, maximumInterval: '2m' }`
 * Used by: agentActivities + conflictActivities (runnable).
 */
export const RETRY_AGENT = {
  backoffCoefficient: 2,
  initialInterval: '30s',
  maximumAttempts: 2,
  maximumInterval: '2m',
} satisfies RetryPolicy;

/**
 * 2 attempts, 5s → 30s backoff. Sandboxed shell/container/gate steps (workflow-
 * level retry/warn/block comes from the spec's onFail policy, so Temporal retries
 * stay low).
 * `{ backoffCoefficient: 2, initialInterval: '5s', maximumAttempts: 2, maximumInterval: '30s' }`
 * Used by: runShellStep, runContainerStep, the six quality gates (runnable).
 */
export const RETRY_SANDBOX = {
  backoffCoefficient: 2,
  initialInterval: '5s',
  maximumAttempts: 2,
  maximumInterval: '30s',
} satisfies RetryPolicy;

/**
 * 2 attempts, 10s → 1m backoff. Secondary / proactive LLM + HTTP work.
 * `{ backoffCoefficient: 2, initialInterval: '10s', maximumAttempts: 2, maximumInterval: '1m' }`
 * Used by: PRD decomposition (runnable); runChannelAmbientDigest (channelAmbient);
 * evaluateReactiveInterjection (channelReactive).
 */
export const RETRY_LLM_LIGHT = {
  backoffCoefficient: 2,
  initialInterval: '10s',
  maximumAttempts: 2,
  maximumInterval: '1m',
} satisfies RetryPolicy;

/**
 * Single attempt, 30s initial interval. Best-effort ambient activities that are
 * heavier than the digest and not worth a Temporal-level retry.
 * `{ backoffCoefficient: 2, initialInterval: '30s', maximumAttempts: 1 }`
 * Used by: consolidateChannelMemory, sweepChannelOpenItems,
 * passiveIngestChannelMemory, flagOrgSignals (channelAmbient).
 */
export const RETRY_ONCE_SLOW = {
  backoffCoefficient: 2,
  initialInterval: '30s',
  maximumAttempts: 1,
} satisfies RetryPolicy;

/**
 * 3 attempts, 2s → 30s backoff. Quick run-record lifecycle DB writes
 * (startChannelRun / finalizeChannelRun / thread-session / task-run rows).
 * `{ backoffCoefficient: 2, initialInterval: '2s', maximumAttempts: 3, maximumInterval: '30s' }`
 * Used by: channelAmbient, channelReactive, channelAssistant (run-record + task-run proxies).
 */
export const RETRY_RUN_RECORD = {
  backoffCoefficient: 2,
  initialInterval: '2s',
  maximumAttempts: 3,
  maximumInterval: '30s',
} satisfies RetryPolicy;

/**
 * 3 attempts, 5s → 30s backoff. Scheduled fan-out reads + memory re-embedding.
 * `{ backoffCoefficient: 2, initialInterval: '5s', maximumAttempts: 3, maximumInterval: '30s' }`
 * Used by: reembedMemoryItemActivity (reembedMemory); getReposForConsolidation
 * (scheduledConsolidation); getDatasetsForRevalidation + revalidateDatasetActivity
 * (scheduledRevalidation).
 */
export const RETRY_SCHEDULED = {
  backoffCoefficient: 2,
  initialInterval: '5s',
  maximumAttempts: 3,
  maximumInterval: '30s',
} satisfies RetryPolicy;

/**
 * Exactly one attempt (no retry). For activities that own an internal
 * repair/poll loop or perform a non-idempotent write, where a Temporal retry
 * would re-burn tokens or duplicate rows.
 * `{ maximumAttempts: 1 }`
 * Used by: waitForCiByPolling (runnable); createChannelWorkflowDraft /
 * refineChannelWorkflowDraft (channelAssistant); generateWorkflowSpec +
 * persistDraftTemplate (workflowAuthor / workflowAuthorJob).
 */
export const RETRY_SINGLE_ATTEMPT = {
  maximumAttempts: 1,
} satisfies RetryPolicy;

// ── Timeout tiers ───────────────────────────────────────────────────────────
//
// Named by their exact literal duration string so a reviewer can confirm no
// value changed. Short-form (`'30m'`) and long-form (`'30 minutes'`) spellings
// are kept as distinct constants because both appear verbatim in the source and
// are preserved exactly.

/** `'30s'` — quick DB reads/writes (state + run-record + short Slack posts). */
export const T_30S: Duration = '30s';
/** `'1m'` — quick config read / re-embed. */
export const T_1M: Duration = '1m';
/** `'2m'` — heartbeat tier for node/gate/context activities + short GitHub/explain calls. */
export const T_2M: Duration = '2m';
/** `'5m'` — heartbeat + startToClose tier for standard LLM activities. */
export const T_5M: Duration = '5m';
/** `'10m'` — declarative node activities (agent/eval/mcp) + channel consolidation. */
export const T_10M: Duration = '10m';
/** `'15m'` — merge / quality-gate / PRD startToClose. */
export const T_15M: Duration = '15m';
/** `'30m'` — long implementer + conflict-resolution startToClose. */
export const T_30M: Duration = '30m';
/** `'60m'` — sandboxed shell / container steps. */
export const T_60M: Duration = '60m';

/** `'2 minutes'` — scheduled/eval short config reads (long-form literal). */
export const T_2_MINUTES: Duration = '2 minutes';
/** `'30 minutes'` — lesson consolidation + dataset re-validation (long-form literal). */
export const T_30_MINUTES: Duration = '30 minutes';
/** `'5 minutes'` — eval harness heartbeat (long-form literal). */
export const T_5_MINUTES: Duration = '5 minutes';
/** `'4 hours'` — full offline eval benchmark (many multi-minute Docker + LLM cases). */
export const T_4_HOURS: Duration = '4 hours';
