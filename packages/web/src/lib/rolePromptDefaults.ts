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
  COMMIT_TO_MEMORY: MEMORY_SUMMARIZER_PROMPT,
  IMPLEMENTER: IMPLEMENTER_SYSTEM_PROMPT,
  PLANNER: PLANNER_AGENT_PROMPT,
  // REVIEWER uses the domain-logic prompt as the representative default.
  // A single REVIEWER override replaces all three reviewer agents (security,
  // domain logic, performance) — see ROLE_PROMPT_NOTES below.
  REVIEWER: DOMAIN_LOGIC_REVIEWER_PROMPT,
  SECURITY_REVIEW: SECURITY_REVIEW_PROMPT,
  VALIDATE_CONTEXT: CONTEXT_VALIDATOR_PROMPT,
};

// Extra note shown in the UI for roles where one override affects multiple agents,
// or where the prompt override is not yet wired into the runtime.
export const ROLE_PROMPT_NOTES: Partial<Record<ModelRole, string>> = {
  REVIEWER:
    'This override replaces all three reviewer agent prompts (security, domain logic, performance) simultaneously.',
  SECURITY_REVIEW:
    'The model-spec and credential settings apply. System prompt override is not yet wired into the pre-commit security gate — only the model selection takes effect.',
};
