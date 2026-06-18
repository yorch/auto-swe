// Side-effect import: registers built-in codemods (v1→v2, …) at module load.
import './codemods.js';

export type {
  AnalyticsResult,
  AnalyticsRunRow,
  AnalyticsStepRow,
  GlobalAnalyticsResult,
  GlobalAnalyticsTemplateRow,
  SignificanceHint,
} from './analytics.js';
export {
  computeAnalytics,
  computeGlobalAnalytics,
  MIN_SAMPLES_FOR_SIGNIFICANCE,
} from './analytics.js';
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
  NodeSchema,
  parseWorkflowSpec,
  SPEC_SCHEMA_VERSION,
  WorkflowSpecSchema,
} from './spec.js';
export type { SpecDiff, SpecMetaChange } from './specDiff.js';
export { diffSpecs, specsEqual } from './specDiff.js';
export {
  AGENT_TOOL_KEYS,
  type AgentToolKey,
  assertBuiltinStepsRegistered,
  getStepMetadata,
  hasStep,
  listSteps,
  MCP_TOOL_KEY,
} from './stepRegistry.js';
