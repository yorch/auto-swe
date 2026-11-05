import type { OnboardingRequest } from './onboardingPr.js';

/**
 * The contract between whoever starts an onboarding pull request (the gateway) and the worker's
 * workflow. Dependency-free at runtime, so a workflow isolate can import it: `onboardingPr.ts`
 * (which parses YAML and validates with Zod) is imported for its types only, and a type import is
 * erased.
 */

export const ONBOARDING_PR_WORKFLOW_TYPE = 'onboardingPrWorkflow';

export interface OnboardingPrInput {
  connectionId: string;
  files: OnboardingRequest['files'];
  proposedById: string;
  /** First 16 hex digits of a sha256 over the rendered files, computed by the gateway. */
  contentHash: string;
}

export interface OnboardingPrResult {
  status: 'opened' | 'updated' | 'nothing_to_do';
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  /** Paths the pull request adds or changes. */
  changed: string[];
  /** Paths left alone because the repository already has identical content. */
  skipped: string[];
}

/**
 * One run per repository and content: the same request later joins or follows the same id. The
 * whole connection id is part of it, so no other repository's id can share its prefix.
 */
export function onboardingPrWorkflowId(connectionId: string, contentHash: string): string {
  return `onboard-${connectionId}-${contentHash}`;
}
