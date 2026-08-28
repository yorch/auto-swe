// Channel assistant (Phase 3) — ambient digest
export { runChannelAmbientDigest } from './channelAmbient.js';
// Channel assistant (Phase 0) — channel-resident Slack assistant
// Phase 4 adds live-progress (placeholder + chat.update) activities.
export {
  postChannelPlaceholder,
  postChannelReply,
  runChannelAssistantTurn,
  updateChannelReply,
} from './channelAssistant.js';
// Channel assistant (Gap C) — open-item tracking + follow-up
export type {
  SweepChannelOpenItemsInput,
  SweepChannelOpenItemsResult,
} from './channelOpenItems.js';
export { sweepChannelOpenItems } from './channelOpenItems.js';
// Channel assistant (Gap A) — reactive interjection (proactive responding)
export type { ChannelReactiveInput, ChannelReactiveResult } from './channelReactive.js';
export { evaluateReactiveInterjection } from './channelReactive.js';
// Channel assistant — lightweight WorkflowRun records for observability
// + persistent live session (Gap H) thread-session touch
export type {
  FinalizeChannelRunInput,
  StartChannelRunInput,
  TouchChannelThreadSessionInput,
} from './channelRun.js';
export { finalizeChannelRun, startChannelRun, touchChannelThreadSession } from './channelRun.js';
// Channel assistant (Phase A) — general agentic task launch from a mention
// Channel assistant (Phase B) — code-task route via the default SWE workflow
export type {
  CreateChannelCodeTaskRunInput,
  CreateChannelTaskRunInput,
  CreateChannelTaskRunResult,
} from './channelTask.js';
export {
  createChannelCodeTaskRun,
  createChannelTaskRun,
  isChannelOverBudgetForTask,
  resolveChannelRepo,
} from './channelTask.js';
// General-route channel-task decomposition: plan → cond → single | composite
export type { ChannelSubtask, PlanChannelTaskResult } from './channelTaskPlan.js';
export { planChannelTask, runChannelSubtasks } from './channelTaskPlan.js';
// Channel assistant — generate a DRAFT workflow template from a description
export type {
  CreateChannelWorkflowDraftInput,
  CreateChannelWorkflowDraftResult,
} from './channelWorkflowDraft.js';
export { createChannelWorkflowDraft } from './channelWorkflowDraft.js';
// Channel assistant — refine the thread's current DRAFT via a follow-up message
export type {
  RefineChannelWorkflowDraftInput,
  RefineChannelWorkflowDraftResult,
} from './channelWorkflowRefine.js';
export { refineChannelWorkflowDraft } from './channelWorkflowRefine.js';
export {
  executeCIFixImplementation,
  executeReviewFixImplementation,
  fetchCILogs,
} from './ciFixLoop.js';
export { commitToMemory } from './commitToMemory.js';
// Channel assistant (Gap F) — channel memory consolidation (de-dup / summarize / expire)
export type {
  ConsolidateChannelMemoryInput,
  ConsolidateChannelMemoryResult,
} from './consolidateChannelMemory.js';
export { consolidateChannelMemory } from './consolidateChannelMemory.js';
export type { ConsolidateLessonsInput, ConsolidateLessonsResult } from './consolidateLessons.js';
export { consolidateLessons } from './consolidateLessons.js';
export type { ContainerStepInput, ContainerStepResult } from './containerStep.js';
export { runContainerStep } from './containerStep.js';
export type { ContextOverflowRef, StoreContextOverflowBatchInput } from './contextOverflow.js';
// `storeContextOverflow` is deliberately not re-exported: no workflow proxies
// it any more, and everything in this file reads as an activity some workflow
// invokes. It stays a module-local helper behind the batch entry point.
export { CONTEXT_OVERFLOW_KIND, storeContextOverflowBatch } from './contextOverflow.js';
export { createOrUpdatePullRequest } from './createOrUpdatePullRequest.js';
export type {
  MergeBranchesInput,
  MergeBranchesResult,
  ResolveMergeConflictInput,
} from './decomposition.js';
export {
  mergeBranches,
  planDecomposition,
  resolveMergeConflict,
  subtaskBranchName,
} from './decomposition.js';
// Repo dependency graph — deterministic manifest/git-signal detection
export type {
  DetectRepoDependenciesInput,
  DetectRepoDependenciesResult,
} from './detectRepoDependencies.js';
export { detectRepoDependencies } from './detectRepoDependencies.js';
export { runEvalHarnessActivity } from './evalHarness.js';
export { revalidateDatasetActivity } from './evalRevalidate.js';
export { executeImplementation } from './executeImplementation.js';
// Natural-language workflow authoring — explain an existing WorkflowSpec
export type {
  ExplainWorkflowSpecInput,
  ExplainWorkflowSpecResult,
} from './explainWorkflowSpec.js';
export { explainWorkflowSpec } from './explainWorkflowSpec.js';
// Channel assistant (Gap B) — org-wide proactive flagging
export type { FlagOrgSignalsInput, FlagOrgSignalsResult } from './flagOrgSignals.js';
export { flagOrgSignals } from './flagOrgSignals.js';
// Natural-language workflow authoring (generate a WorkflowSpec from a description)
export type {
  GenerateWorkflowSpecInput,
  GenerateWorkflowSpecResult,
} from './generateWorkflowSpec.js';
export { generateWorkflowSpec } from './generateWorkflowSpec.js';
// Generic workspace / source / outcome activities for non-SWE connectors
export type {
  ReadSourceInput,
  ReadSourceResult,
  RunToolInput,
  RunToolResult,
  WriteOutcomeInput,
  WriteOutcomeResult,
} from './genericActions.js';
export { readSource, runTool, writeOutcome } from './genericActions.js';
export type { DatasetForRevalidation } from './getDatasetsForRevalidation.js';
export { getDatasetsForRevalidation } from './getDatasetsForRevalidation.js';
export type { RepoForConsolidation } from './getReposForConsolidation.js';
export { getReposForConsolidation } from './getReposForConsolidation.js';
export type { RepoForDependencyScan } from './getReposForDependencyScan.js';
export { getReposForDependencyScan } from './getReposForDependencyScan.js';
// Repo dependency graph — LLM inference of likely edges (proposed, not active)
export type {
  InferRepoDependenciesInput,
  InferRepoDependenciesResult,
} from './inferRepoDependencies.js';
export { inferRepoDependencies } from './inferRepoDependencies.js';
export type { McpCallToolInput, McpCallToolResult } from './mcpCallTool.js';
// P2/WS4 — declarative mcp node (single MCP tool call)
export { mcpCallTool } from './mcpCallTool.js';
// Channel assistant — passive memory ingestion (silent fact extraction)
export type {
  PassiveIngestChannelMemoryInput,
  PassiveIngestChannelMemoryResult,
} from './passiveIngestChannelMemory.js';
export { passiveIngestChannelMemory } from './passiveIngestChannelMemory.js';
export type {
  PersistDraftTemplateInput,
  PersistDraftTemplateResult,
} from './persistDraftTemplate.js';
export { persistDraftTemplate } from './persistDraftTemplate.js';
// Phase 3
export { planEpic } from './planEpic.js';
export type {
  PrdAnalysis,
  PrdDecomposition,
  SubmitResult,
  TrackerItemsResult,
} from './prdWorkflow.js';
export {
  analyzePrd,
  createTrackerItems,
  decomposePrd,
  submitPrdWorkRequests,
} from './prdWorkflow.js';
export { prepareScheduledEvalRun } from './prepareScheduledEvalRun.js';
// Phase 2 quality gates
export type { GateFixInput, GateInput, GateName, GateResult } from './qualityGates.js';
export {
  executeGateFixImplementation,
  runBuild,
  runLint,
  runPerfBench,
  runTests,
  runTypecheck,
  runVulnScan,
} from './qualityGates.js';
// Channel assistant — admin memory edit-with-reembed
export type { ReembedMemoryInput } from './reembedMemory.js';
export { reembedMemoryItemActivity } from './reembedMemory.js';
export type {
  ResolveWorkspaceInput,
  WorkspaceContext,
} from './resolveWorkspace.js';
export { resolveWorkspace } from './resolveWorkspace.js';
export type { RunAgentNodeInput, RunAgentNodeResult } from './runAgentNode.js';
export { runAgentNode } from './runAgentNode.js';
export type { RunEvalNodeInput, RunEvalNodeResult } from './runEvalNode.js';
export { runEvalNode } from './runEvalNode.js';
export { runReviewNetwork } from './runReviewNetwork.js';
// Phase 6 — user-authored shell steps
export type { ShellStepInput, ShellStepResult } from './shellStep.js';
export { runShellStep } from './shellStep.js';
export type { CreateHumanStepInput } from './state.js';
export {
  cancelPendingHumanSteps,
  createHumanStep,
  resolveHumanStep,
  updateDomainState,
} from './state.js';
export {
  createWorkflowRun,
  finalizeWorkflowRun,
  recordWorkflowStep,
  resolveTemplateForRepo,
} from './templates.js';
export { validateContext } from './validateContext.js';
export type { CiWaitConfig, WaitForCiByPollingInput } from './waitForCiByPolling.js';
export { resolveCiWaitConfig, waitForCiByPolling } from './waitForCiByPolling.js';
