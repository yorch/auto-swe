import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import type { CodeResult } from '@auto-swe/shared/types/workflow';
import { CI_FIX_SYSTEM_PROMPT, REVIEW_FIX_SYSTEM_PROMPT } from '../agents/prompts.js';
import { GitHubTokenMissingError, resolveGitHubToken } from '../lib/githubAuth.js';
import { runImplementerFixSession } from './implementerSession.js';

/**
 * Fetches CI logs from the provided URL.
 * Truncates to last 50KB to fit in LLM context.
 */
export async function fetchCILogs(logsUrl?: string): Promise<string> {
  if (!logsUrl) {
    return 'No logs URL provided by CI webhook';
  }

  const ghConfig = await resolveGitHubConfig();
  let githubToken: string | null = null;
  try {
    githubToken = await resolveGitHubToken(ghConfig);
  } catch (err) {
    if (!(err instanceof GitHubTokenMissingError)) {
      // Real auth error (e.g. malformed App credentials) — surface it so the
      // operator knows why the log fetch failed rather than seeing a 401.
      return `Cannot fetch CI logs — GitHub auth error: ${err instanceof Error ? err.message : String(err)}`;
    }
    // No token configured at all: proceed unauthenticated for public repos.
  }
  const response = await fetch(logsUrl, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
    },
  });

  if (!response.ok) {
    return `Failed to fetch CI logs (HTTP ${response.status}): ${await response.text().catch(() => 'no body')}`;
  }

  const fullLog = await response.text();
  // Truncate to last 50KB to fit in LLM context
  return fullLog.slice(-50_000);
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
