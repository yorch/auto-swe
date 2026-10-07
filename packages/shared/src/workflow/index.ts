// Side-effect import: registers built-in codemods (v1→v2, …) at module load.
import './codemods.js';

export type {
  AnalyticsResult,
  AnalyticsRunRow,
  AnalyticsStepRow,
  DailyRunCount,
  GlobalAnalyticsResult,
  GlobalAnalyticsTemplateRow,
  SignificanceHint,
} from './analytics.js';
export {
  computeAnalytics,
  computeDailyRunSeries,
  computeGlobalAnalytics,
  MIN_SAMPLES_FOR_SIGNIFICANCE,
} from './analytics.js';
export type {
  AuthoringAgentRef,
  AuthoringCatalog,
  AuthoringMcpRef,
  WorkflowAuthorOutput,
  WorkflowExplanation,
} from './authoring.js';
export {
  buildAuthorRequestMessage,
  buildExplainRequestMessage,
  buildRefineRequestMessage,
  buildRepairRequestMessage,
  renderAuthoringCatalog,
  WorkflowAuthorOutputSchema,
  WorkflowExplanationSchema,
} from './authoring.js';
export type { Codemod } from './codemod.js';
export { migrateSpec, registerCodemod } from './codemod.js';
export type { CostEstimate, CostRole } from './costEstimator.js';
export {
  DEFAULT_FANOUT_WIDTH,
  DEFAULT_ROLE_PRICING,
  estimateSpecCost,
} from './costEstimator.js';
export { DEFAULT_ENGINEERING_SPEC } from './defaultEngineeringSpec.js';
export type { Context } from './expr.js';
export {
  evalBoolean,
  evalExpr,
  lookupPath,
  resolveBinding,
} from './expr.js';
export type { CancellationToken, Dispatcher, InterpreterResult } from './interpreter.js';
export {
  BranchCancelledError,
  DEFAULT_FANOUT_CONCURRENCY,
  DEFAULT_MAX_TRANSITIONS,
  normalizeApproverCount,
  runSpec,
} from './interpreter.js';
export type {
  BuiltinStepName,
  StepCategory,
  StepFieldDef,
  StepMetadata,
} from './registry-types.js';
export { BUILTIN_STEPS } from './registry-types.js';
export {
  assertShellImageAllowed,
  BUILTIN_SHELL_IMAGES,
  DOCKER_IMAGE_REF_RE,
  isShellImageAllowed,
  ShellImageNotAllowedError,
} from './shellImageAllowlist.js';
export { SignalSlots } from './signalSlots.js';
export type {
  Binding,
  CondNode,
  ContainerStepNode,
  EvalNode,
  EvalScorer,
  FanOutNode,
  HumanApprovalNode,
  HumanDecisionNode,
  HumanInputNode,
  HumanReviewNode,
  Node,
  OnFailMode,
  SetNode,
  ShellNode,
  SignalNode,
  StepNode,
  TerminateNode,
  WorkflowSpec,
} from './spec.js';
export {
  BindingSchema,
  findInvalidPresentation,
  MAX_FANOUT_CONCURRENCY,
  MAX_NODE_GROUP_LENGTH,
  MAX_NODE_TITLE_LENGTH,
  NodeSchema,
  nodeEdges,
  parseWorkflowSpec,
  readNodeEdge,
  SPEC_SCHEMA_VERSION,
  setNodeEdge,
  WorkflowSpecSchema,
  waitDurationMs,
} from './spec.js';
export type { SpecDiff, SpecMetaChange } from './specDiff.js';
export { diffSpecs, specsEqual } from './specDiff.js';
export {
  AGENT_TOOL_KEYS,
  type AgentToolKey,
  assertBuiltinStepsRegistered,
  getStepMetadata,
  hasStep,
  listAllSteps,
  listSteps,
  MCP_TOOL_KEY,
} from './stepRegistry.js';
// Exported only so the worker's workflow test can run the real specs: the package has no
// export path for `templates/`, and (like DEFAULT_ENGINEERING_SPEC) they are pure data.
export { AGENT_REVIEWED_PR_SPEC } from './templates/agentReviewedPr.js';
export { CODE_AND_CI_SPEC } from './templates/codeAndCi.js';
export { CONSENSUS_REVIEW_SPEC } from './templates/consensusReview.js';
export { DEPENDENCY_UPDATE_SPEC } from './templates/dependencyUpdate.js';
export { FOUR_EYES_SPEC } from './templates/fourEyes.js';
export type {
  ValidateSpecOptions,
  ValidationIssue,
  ValidationReport,
  ValidationSeverity,
} from './validateSpec.js';
export {
  findInternalSteps,
  formatValidationErrors,
  formatValidationIssue,
  splitGroups,
  validateSpec,
} from './validateSpec.js';
