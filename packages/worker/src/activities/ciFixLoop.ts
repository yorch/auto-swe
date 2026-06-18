import type { CodeResult } from '@auto-swe/shared/types/workflow';
import { CI_FIX_SYSTEM_PROMPT, REVIEW_FIX_SYSTEM_PROMPT } from '../agents/prompts.js';
import { getScmProvider } from '../lib/scm/index.js';
import { runImplementerFixSession } from './implementerSession.js';

/**
 * Fetches CI logs from the provided URL. Provider-specific URL/auth handling
 * (and truncation to the last 50KB to fit in LLM context) lives in the
 * ScmProvider implementation.
 */
export async function fetchCILogs(logsUrl?: string): Promise<string> {
  if (!logsUrl) {
    return 'No logs URL provided by CI webhook';
  }
  return getScmProvider().fetchCiLogs(logsUrl);
}

/**
 * Re-provisions a workspace on the existing branch and runs the implementer
 * agent in CI fix mode with the failure logs injected. Thin wrapper around
 * the shared fix session (workspace lifecycle, tracing, and security scans
 * live there so all fix paths behave identically).
 */
export async function executeCIFixImplementation(
  failureContext: string,
  previousCodeResult: CodeResult,
  systemPromptOverride?: string
): Promise<CodeResult> {
  return runImplementerFixSession({
    agentKey: 'ciFixer',
    commitMessage: `auto: fix CI for ${previousCodeResult.branch}`,
    defaultSystemPrompt: CI_FIX_SYSTEM_PROMPT,
    mode: 'CI_FIX',
    notes: (testResult) =>
      `CI fix iteration. Failure context analyzed: ${failureContext.length} chars. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
    previousCodeResult,
    systemPromptOverride,
    usageEventName: 'llm.ci_fix',
    userPayload: {
      ciLogs: failureContext,
      previousTestResults: previousCodeResult.testResults,
    },
  });
}

/**
 * Re-provisions a workspace on the existing branch and runs the implementer
 * agent in review fix mode with the review findings injected.
 *
 * Separate from executeCIFixImplementation because review rejections require
 * a different prompt and context shape than CI failures.
 */
export async function executeReviewFixImplementation(
  rejectionSummary: string,
  previousCodeResult: CodeResult,
  systemPromptOverride?: string
): Promise<CodeResult> {
  return runImplementerFixSession({
    agentKey: 'reviewFixer',
    commitMessage: `auto: address review findings for ${previousCodeResult.branch}`,
    defaultSystemPrompt: REVIEW_FIX_SYSTEM_PROMPT,
    mode: 'REVIEW_FIX',
    notes: (testResult) =>
      `Review fix iteration. ${rejectionSummary.split('\n').length} findings addressed. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
    previousCodeResult,
    systemPromptOverride,
    usageEventName: 'llm.review_fix',
    userPayload: {
      previousTestResults: previousCodeResult.testResults,
      reviewFindings: rejectionSummary,
    },
  });
}
