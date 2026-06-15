import {
  CONTEXT_VALIDATOR_PROMPT,
  DOMAIN_LOGIC_REVIEWER_PROMPT,
  IMPLEMENTER_SYSTEM_PROMPT,
  MEMORY_SUMMARIZER_PROMPT,
  PLANNER_AGENT_PROMPT,
  SECURITY_REVIEW_PROMPT,
} from '@auto-swe/shared/lib/agentPrompts';
import type { ModelRole } from '@/hooks/useModelConfig';

export const ROLE_DEFAULT_PROMPTS: Record<ModelRole, string> = {
  commitToMemory: MEMORY_SUMMARIZER_PROMPT,
  implementer: IMPLEMENTER_SYSTEM_PROMPT,
  planner: PLANNER_AGENT_PROMPT,
  // reviewer uses the domain-logic prompt as the representative default.
  // A single reviewer override replaces all three reviewer agents (security,
  // domain logic, performance) — see ROLE_PROMPT_NOTES below.
  reviewer: DOMAIN_LOGIC_REVIEWER_PROMPT,
  securityReview: SECURITY_REVIEW_PROMPT,
  validateContext: CONTEXT_VALIDATOR_PROMPT,
};

// Extra note shown in the UI for roles where one override affects multiple agents,
// or where the prompt override is not yet wired into the runtime.
export const ROLE_PROMPT_NOTES: Partial<Record<ModelRole, string>> = {
  reviewer:
    'This override replaces all three reviewer agent prompts (security, domain logic, performance) simultaneously.',
  securityReview:
    'The model-spec and credential settings apply. System prompt override is not yet wired into the pre-commit security gate — only the model selection takes effect.',
};
