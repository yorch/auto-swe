// Claude Tag (Phase 3) — ambient digest
export { runChannelAmbientDigest } from './channelAmbient.js';
// Claude Tag (Phase 0) — channel-resident Slack assistant
// Phase 4 adds live-progress (placeholder + chat.update) activities.
export {
  postChannelPlaceholder,
  postChannelReply,
  runChannelAssistantTurn,
  updateChannelReply,
} from './channelAssistant.js';
export {
  executeCIFixImplementation,
  executeReviewFixImplementation,
  fetchCILogs,
} from './ciFixLoop.js';
export { commitToMemory } from './commitToMemory.js';
export type { ConsolidateLessonsInput, ConsolidateLessonsResult } from './consolidateLessons.js';
export { consolidateLessons } from './consolidateLessons.js';
export type { ContainerStepInput, ContainerStepResult } from './containerStep.js';
export { runContainerStep } from './containerStep.js';
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
export { runEvalHarnessActivity } from './evalHarness.js';
export { revalidateDatasetActivity } from './evalRevalidate.js';
export { executeImplementation } from './executeImplementation.js';
export type { RepoForConsolidation } from './getReposForConsolidation.js';
export { getReposForConsolidation } from './getReposForConsolidation.js';
export type { McpCallToolInput, McpCallToolResult } from './mcpCallTool.js';
// P2/WS4 — declarative mcp node (single MCP tool call)
export { mcpCallTool } from './mcpCallTool.js';
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
// Claude Tag — admin memory edit-with-reembed
export type { ReembedMemoryInput } from './reembedMemory.js';
export { reembedMemoryItemActivity } from './reembedMemory.js';
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
