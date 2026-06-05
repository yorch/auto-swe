import { DEFAULT_ENGINEERING_SPEC } from '../defaultEngineeringSpec.js';
import type { WorkflowSpec } from '../spec.js';
import { CANARY_ROLLOUT_SPEC } from './canaryRollout.js';
import { CODE_AND_CI_SPEC } from './codeAndCi.js';
import { CONSENSUS_REVIEW_SPEC } from './consensusReview.js';
import { DEPENDENCY_UPDATE_SPEC } from './dependencyUpdate.js';
import { FOUR_EYES_SPEC } from './fourEyes.js';
import { FULL_SUPERVISED_SPEC } from './fullSupervised.js';
import { HOTFIX_SPEC } from './hotfix.js';
import { HUMAN_CODE_REVIEW_SPEC } from './humanCodeReview.js';
import { MIGRATION_SPEC } from './migration.js';
import { PARALLEL_FAN_OUT_SPEC } from './parallelFanOut.js';
import { PR_APPROVAL_GATE_SPEC } from './prApprovalGate.js';
import { REVIEW_AND_MERGE_SPEC } from './reviewAndMerge.js';
import { SCOPE_CLARIFICATION_SPEC } from './scopeClarification.js';
import { SECURITY_TRIAGE_SPEC } from './securityTriage.js';
import { SIGNAL_GATED_ROLLOUT_SPEC } from './signalGatedRollout.js';
import { TIERED_ESCALATION_SPEC } from './tieredEscalation.js';

export interface BuiltinTemplate {
  name: string;
  description: string;
  spec: WorkflowSpec;
  /** Marks the global default used when a team has no team-scoped template. */
  isDefault?: boolean;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  // ── Core (always seeded, first is the global default) ────────────────────
  {
    description: DEFAULT_ENGINEERING_SPEC.description,
    isDefault: true,
    name: DEFAULT_ENGINEERING_SPEC.name,
    spec: DEFAULT_ENGINEERING_SPEC,
  },

  // ── Automated (no HITL) ──────────────────────────────────────────────────
  { description: HOTFIX_SPEC.description, name: HOTFIX_SPEC.name, spec: HOTFIX_SPEC },
  {
    description: DEPENDENCY_UPDATE_SPEC.description,
    name: DEPENDENCY_UPDATE_SPEC.name,
    spec: DEPENDENCY_UPDATE_SPEC,
  },
  {
    description: CODE_AND_CI_SPEC.description,
    name: CODE_AND_CI_SPEC.name,
    spec: CODE_AND_CI_SPEC,
  },
  {
    description: REVIEW_AND_MERGE_SPEC.description,
    name: REVIEW_AND_MERGE_SPEC.name,
    spec: REVIEW_AND_MERGE_SPEC,
  },
  {
    description: CONSENSUS_REVIEW_SPEC.description,
    name: CONSENSUS_REVIEW_SPEC.name,
    spec: CONSENSUS_REVIEW_SPEC,
  },

  // ── Signal-driven ────────────────────────────────────────────────────────
  {
    description: SIGNAL_GATED_ROLLOUT_SPEC.description,
    name: SIGNAL_GATED_ROLLOUT_SPEC.name,
    spec: SIGNAL_GATED_ROLLOUT_SPEC,
  },
  {
    description: CANARY_ROLLOUT_SPEC.description,
    name: CANARY_ROLLOUT_SPEC.name,
    spec: CANARY_ROLLOUT_SPEC,
  },

  // ── Parallel execution ───────────────────────────────────────────────────
  {
    description: PARALLEL_FAN_OUT_SPEC.description,
    name: PARALLEL_FAN_OUT_SPEC.name,
    spec: PARALLEL_FAN_OUT_SPEC,
  },

  // ── HITL examples ────────────────────────────────────────────────────────
  {
    description: PR_APPROVAL_GATE_SPEC.description,
    name: PR_APPROVAL_GATE_SPEC.name,
    spec: PR_APPROVAL_GATE_SPEC,
  },
  {
    description: SCOPE_CLARIFICATION_SPEC.description,
    name: SCOPE_CLARIFICATION_SPEC.name,
    spec: SCOPE_CLARIFICATION_SPEC,
  },
  {
    description: SECURITY_TRIAGE_SPEC.description,
    name: SECURITY_TRIAGE_SPEC.name,
    spec: SECURITY_TRIAGE_SPEC,
  },
  {
    description: HUMAN_CODE_REVIEW_SPEC.description,
    name: HUMAN_CODE_REVIEW_SPEC.name,
    spec: HUMAN_CODE_REVIEW_SPEC,
  },
  {
    description: TIERED_ESCALATION_SPEC.description,
    name: TIERED_ESCALATION_SPEC.name,
    spec: TIERED_ESCALATION_SPEC,
  },
  { description: FOUR_EYES_SPEC.description, name: FOUR_EYES_SPEC.name, spec: FOUR_EYES_SPEC },
  { description: MIGRATION_SPEC.description, name: MIGRATION_SPEC.name, spec: MIGRATION_SPEC },
  {
    description: FULL_SUPERVISED_SPEC.description,
    name: FULL_SUPERVISED_SPEC.name,
    spec: FULL_SUPERVISED_SPEC,
  },
];

// Re-export individual specs so callers can import from this module directly.
export { DEFAULT_ENGINEERING_SPEC } from '../defaultEngineeringSpec.js';
export { CANARY_ROLLOUT_SPEC } from './canaryRollout.js';
export { CODE_AND_CI_SPEC } from './codeAndCi.js';
export { CONSENSUS_REVIEW_SPEC } from './consensusReview.js';
export { DEPENDENCY_UPDATE_SPEC } from './dependencyUpdate.js';
export { FOUR_EYES_SPEC } from './fourEyes.js';
export { FULL_SUPERVISED_SPEC } from './fullSupervised.js';
export { HOTFIX_SPEC } from './hotfix.js';
export { HUMAN_CODE_REVIEW_SPEC } from './humanCodeReview.js';
export { MIGRATION_SPEC } from './migration.js';
export { PARALLEL_FAN_OUT_SPEC } from './parallelFanOut.js';
export { PR_APPROVAL_GATE_SPEC } from './prApprovalGate.js';
export { REVIEW_AND_MERGE_SPEC } from './reviewAndMerge.js';
export { SCOPE_CLARIFICATION_SPEC } from './scopeClarification.js';
export { SECURITY_TRIAGE_SPEC } from './securityTriage.js';
export { SIGNAL_GATED_ROLLOUT_SPEC } from './signalGatedRollout.js';
export { TIERED_ESCALATION_SPEC } from './tieredEscalation.js';
