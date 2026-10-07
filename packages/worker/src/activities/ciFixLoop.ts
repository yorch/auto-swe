import { prisma } from '@auto-swe/shared/db';
import type { CodeResult } from '@auto-swe/shared/types/workflow';
import { CI_FIX_SYSTEM_PROMPT, REVIEW_FIX_SYSTEM_PROMPT } from '../agents/prompts.js';
import {
  CI_FAILURE_TRACE_CHARS,
  CI_FAILURE_TRACE_EVENT,
  currentActivityId,
} from '../lib/attemptTrace.js';
import { rejectionText } from '../lib/rejectionText.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { runImplementerFixSession } from './implementerSession.js';

/**
 * Fetches CI logs from the provided URL. Provider-specific URL/auth handling
 * (and truncation to the last 50KB to fit in LLM context) lives in the
 * ScmProvider implementation.
 */
export async function fetchCILogs(logsUrl?: string, repoId?: string): Promise<string> {
  if (!logsUrl) {
    return 'No logs URL provided by CI webhook';
  }
  // Resolve the repository so the credential comes from ITS installation. A
  // repo on a non-default installation is unreadable with the singleton's
  // token, and the failure is a 404 that leaves the fix loop reasoning about
  // an error message instead of the build output.
  const repo = repoId
    ? await prisma.connection.findUnique({
        include: { installation: { select: { host: true, installationId: true } } },
        where: { id: repoId },
      })
    : null;
  const repoRef = repo?.organizationName && repo.repoName ? toRepoRef(repo) : undefined;
  return getScmProvider(repoRef).fetchCiLogs(logsUrl, repoRef);
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
    // The end of a CI log is where the failure is.
    lessonQuery: failureContext.slice(-2_000),
    mode: 'CI_FIX',
    notes: (testResult) =>
      `CI fix iteration. Failure context analyzed: ${failureContext.length} chars. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
    previousCodeResult,
    // Each failure the loop fixes, kept for a lesson about the run (`lib/attemptTrace.ts`).
    startEvent: {
      name: CI_FAILURE_TRACE_EVENT,
      outputJson: {
        ...(currentActivityId() ? { activityId: currentActivityId() } : {}),
        logTail: failureContext.slice(-CI_FAILURE_TRACE_CHARS),
      },
    },
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
 *
 * `rejection` is the review network's summary, or a fan-out review's per-branch
 * results (`consensus-review`), which {@link rejectionText} turns into the same
 * kind of text.
 */
export async function executeReviewFixImplementation(
  rejection: unknown,
  previousCodeResult: CodeResult,
  systemPromptOverride?: string,
  allowedPaths?: string[]
): Promise<CodeResult> {
  const rejectionSummary = rejectionText(rejection);
  return runImplementerFixSession({
    agentKey: 'reviewFixer',
    allowedPaths,
    commitMessage: `auto: address review findings for ${previousCodeResult.branch}`,
    defaultSystemPrompt: REVIEW_FIX_SYSTEM_PROMPT,
    lessonQuery: rejectionSummary,
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
