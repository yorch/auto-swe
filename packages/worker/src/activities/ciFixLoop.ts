import { prisma } from '@auto-swe/shared/db';
import type { CodeResult, TestRunResult } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { createImplementerAgent } from '../agents/implementer.js';
import { CI_FIX_SYSTEM_PROMPT, REVIEW_FIX_SYSTEM_PROMPT } from '../agents/prompts.js';
import { currentWorkflowId } from '../lib/activityContext.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { getExecErrorStdout } from '../lib/errors.js';
import { getGitHubToken } from '../lib/githubAuth.js';
import { detectTestCommand, parseDiffToFileChanges, parseTestOutput } from './utils.js';
import { createWorkspace, shellQuote } from './workspace.js';

/**
 * Fetches CI logs from the provided URL.
 * Truncates to last 50KB to fit in LLM context.
 */
export async function fetchCILogs(logsUrl?: string): Promise<string> {
  if (!logsUrl) return 'No logs URL provided by CI webhook';

  const response = await fetch(logsUrl, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Bearer ${await getGitHubToken()}`,
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
 * agent in CI fix mode with the failure logs injected.
 */
export async function executeCIFixImplementation(
  failureContext: string,
  previousCodeResult: CodeResult
): Promise<CodeResult> {
  const workflow = await prisma.activeWorkflow.findFirst({
    include: { repository: true },
    where: { assignedBranch: previousCodeResult.branch },
  });

  if (!workflow?.repository) {
    throw new Error(`No workflow found for branch ${previousCodeResult.branch}`);
  }

  const repo = workflow.repository;
  const githubUrl = repo.githubUrl ?? process.env.GITHUB_URL ?? 'https://github.com';
  const repoUrl = `${githubUrl}/${repo.organizationName}/${repo.repoName}.git`;
  const githubToken = await getGitHubToken(repo.githubAppInstallationId);

  // Provision workspace and checkout the existing branch
  const workspace = createWorkspace(
    repoUrl,
    previousCodeResult.branch,
    repo.defaultBranch,
    githubToken,
    repo.executorImage ?? 'node:24-alpine'
  );

  try {
    heartbeat('CI fix workspace provisioned');

    // Detect test framework
    const packageJson = workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    const { agent } = await createImplementerAgent(workspace);

    // Run the agent in CI fix mode
    const ciFix = await agent.generate(
      [
        { content: CI_FIX_SYSTEM_PROMPT, role: 'system' },
        {
          content: JSON.stringify({
            ciLogs: failureContext,
            mode: 'CI_FIX',
            previousDiff: previousCodeResult.diff.slice(-20_000),
            previousTestResults: previousCodeResult.testResults,
          }),
          role: 'user',
        },
      ],
      { toolChoice: 'auto' }
    );

    heartbeat('CI fix agent completed');

    if (ciFix.usage) {
      await recordLlmUsage(currentWorkflowId(), 'implementer', ciFix.usage, 'llm.ci_fix');
    }

    // Run tests locally after fix
    let testResult: TestRunResult;
    try {
      const startTime = Date.now();
      const testOutput = workspace.exec(testCommand);
      testResult = parseTestOutput(testOutput, Date.now() - startTime);
    } catch (err: unknown) {
      testResult = {
        duration_ms: 0,
        failing: 1,
        passed: false,
        passing: 0,
        stdout: getExecErrorStdout(err),
        total: 0,
      };
    }

    // Commit and push the fix (skip if agent made no changes to avoid empty CI cycles)
    workspace.exec('git add -A');
    workspace.exec(
      `git diff --cached --quiet || git commit -m "auto: fix CI for ${previousCodeResult.branch}"`
    );
    workspace.exec(`git push origin ${shellQuote(previousCodeResult.branch)}`);

    const diff = workspace.exec(`git diff origin/${repo.defaultBranch}`);
    const headSha = workspace.exec('git rev-parse HEAD').trim();

    return {
      branch: previousCodeResult.branch,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      headSha,
      implementationNotes: `CI fix iteration. Failure context analyzed: ${failureContext.length} chars. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
      testResults: testResult,
    };
  } finally {
    workspace.destroy();
  }
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
  previousCodeResult: CodeResult
): Promise<CodeResult> {
  const workflow = await prisma.activeWorkflow.findFirst({
    include: { repository: true },
    where: { assignedBranch: previousCodeResult.branch },
  });

  if (!workflow?.repository) {
    throw new Error(`No workflow found for branch ${previousCodeResult.branch}`);
  }

  const repo = workflow.repository;
  const githubUrl = repo.githubUrl ?? process.env.GITHUB_URL ?? 'https://github.com';
  const repoUrl = `${githubUrl}/${repo.organizationName}/${repo.repoName}.git`;
  const githubToken = await getGitHubToken(repo.githubAppInstallationId);

  const workspace = createWorkspace(
    repoUrl,
    previousCodeResult.branch,
    repo.defaultBranch,
    githubToken,
    repo.executorImage ?? 'node:24-alpine'
  );

  try {
    heartbeat('review fix workspace provisioned');

    const packageJson = workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    const { agent } = await createImplementerAgent(workspace);

    const reviewFix = await agent.generate(
      [
        { content: REVIEW_FIX_SYSTEM_PROMPT, role: 'system' },
        {
          content: JSON.stringify({
            mode: 'REVIEW_FIX',
            previousDiff: previousCodeResult.diff.slice(-20_000),
            previousTestResults: previousCodeResult.testResults,
            reviewFindings: rejectionSummary,
          }),
          role: 'user',
        },
      ],
      { toolChoice: 'auto' }
    );

    heartbeat('review fix agent completed');

    if (reviewFix.usage) {
      await recordLlmUsage(currentWorkflowId(), 'implementer', reviewFix.usage, 'llm.review_fix');
    }

    let testResult: TestRunResult;
    try {
      const startTime = Date.now();
      const testOutput = workspace.exec(testCommand);
      testResult = parseTestOutput(testOutput, Date.now() - startTime);
    } catch (err: unknown) {
      testResult = {
        duration_ms: 0,
        failing: 1,
        passed: false,
        passing: 0,
        stdout: getExecErrorStdout(err),
        total: 0,
      };
    }

    workspace.exec('git add -A');
    workspace.exec(
      `git diff --cached --quiet || git commit -m "auto: address review findings for ${previousCodeResult.branch}"`
    );
    workspace.exec(`git push origin ${shellQuote(previousCodeResult.branch)}`);

    const diff = workspace.exec(`git diff origin/${repo.defaultBranch}`);
    const headSha = workspace.exec('git rev-parse HEAD').trim();

    return {
      branch: previousCodeResult.branch,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      headSha,
      implementationNotes: `Review fix iteration. ${rejectionSummary.split('\n').length} findings addressed. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
      testResults: testResult,
    };
  } finally {
    workspace.destroy();
  }
}
