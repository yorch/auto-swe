/**
 * Re-export barrel — all built-in templates now live in ./templates/.
 * This file is kept for backwards-compatibility with existing imports.
 */
export {
  BUILTIN_TEMPLATES,
  type BuiltinTemplate,
  CODE_AND_CI_SPEC,
  DEFAULT_ENGINEERING_SPEC,
  FULL_SUPERVISED_SPEC,
  HUMAN_CODE_REVIEW_SPEC,
  PARALLEL_FAN_OUT_SPEC,
  PR_APPROVAL_GATE_SPEC,
  REVIEW_AND_MERGE_SPEC,
  SCOPE_CLARIFICATION_SPEC,
  SECURITY_TRIAGE_SPEC,
  SIGNAL_GATED_ROLLOUT_SPEC,
  TIERED_ESCALATION_SPEC,
} from './templates/index.js';
