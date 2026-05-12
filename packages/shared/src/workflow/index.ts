// Side-effect import: registers built-in codemods (v1→v2, …) at module load.
import './codemods.js';

export type { Codemod } from './codemod.js';
export { migrateSpec, registerCodemod } from './codemod.js';
export { DEFAULT_ENGINEERING_SPEC } from './defaultEngineeringSpec.js';
export type { Context } from './expr.js';
export {
  evalBoolean,
  evalExpr,
  lookupPath,
  resolveBinding,
} from './expr.js';
export type { Dispatcher, InterpreterResult } from './interpreter.js';
export { DEFAULT_MAX_TRANSITIONS, runSpec } from './interpreter.js';
export type {
  BuiltinStepName,
  StepCategory,
  StepFieldDef,
  StepMetadata,
} from './registry-types.js';
export { BUILTIN_STEPS } from './registry-types.js';
export { SignalSlots } from './signalSlots.js';
export type {
  Binding,
  CondNode,
  Node,
  OnFailMode,
  SetNode,
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
