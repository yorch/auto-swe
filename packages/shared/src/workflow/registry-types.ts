/**
 * Step registry — shared types for steps that can appear in WorkflowSpec nodes.
 *
 * The full registry (with activity wiring) lives in the worker package
 * (packages/worker/src/lib/stepRegistry.ts). Web + gateway only need the
 * metadata defined here to render the editor UI and validate templates.
 */

export type StepCategory = 'agent' | 'gate' | 'control' | 'vcs' | 'shell';

export interface StepFieldDef {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'json';
  enumValues?: readonly string[];
  required?: boolean;
  default?: unknown;
  description?: string;
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
      | 'commitToMemory';
    tokensIn?: number;
    tokensOut?: number;
  };
}

/** Canonical list of step names known to phase 1. Worker validates at startup. */
export const BUILTIN_STEPS = [
  'updateDomainState',
  'validateContext',
  'executeImplementation',
  'runReviewNetwork',
  'executeReviewFixImplementation',
  'executeCIFixImplementation',
  'createOrUpdatePullRequest',
  'fetchCILogs',
  'commitToMemory',
] as const;
export type BuiltinStepName = (typeof BUILTIN_STEPS)[number];
