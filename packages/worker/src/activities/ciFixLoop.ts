import { heartbeat } from '@temporalio/activity';
import { prisma } from '@auto-swe/shared/db';
import type { CodeResult, TestRunResult } from '@auto-swe/shared/types/workflow';
import { createWorkspace } from './workspace.js';
import { createImplementerAgent } from '../agents/implementer.js';
import { CI_FIX_SYSTEM_PROMPT, REVIEW_FIX_SYSTEM_PROMPT } from '../agents/prompts.js';
import { detectTestCommand, parseTestOutput, parseDiffToFileChanges } from './utils.js';

/**
 * Fetches CI logs from the provided URL.
 * Truncates to last 50KB to fit in LLM context.
 */
export async function fetchCILogs(logsUrl?: string): Promise<string> {
  if (!logsUrl) return 'No logs URL provided by CI webhook';

  const response = await fetch(logsUrl, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github.v3+json',
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
  previousCodeResult: CodeResult,
): Promise<CodeResult> {
  const workflow = await prisma.activeWorkflow.findFirst({
    where: { assignedBranch: previousCodeResult.branch },
    include: { repository: true },
  });

  if (!workflow?.repository) {
    throw new Error(`No workflow found for branch ${previousCodeResult.branch}`);
  }

  const repo = workflow.repository;
  const githubUrl = repo.githubUrl ?? process.env.GITHUB_URL ?? 'https://github.com';
  const repoUrl = `${githubUrl}/${repo.organizationName}/${repo.repoName}.git`;
  const githubToken = process.env.GITHUB_TOKEN!;

  // Provision workspace and checkout the existing branch
  const workspace = createWorkspace(
    repoUrl,
    previousCodeResult.branch,
    repo.defaultBranch,
    githubToken,
    repo.executorImage ?? 'node:24-alpine',
  );

  try {
    heartbeat('CI fix workspace provisioned');

    // Detect test framework
    const packageJson = workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    const { agent } = createImplementerAgent(workspace);

    // Run the agent in CI fix mode
    await agent.generate(
      [
        { role: 'system', content: CI_FIX_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            mode: 'CI_FIX',
            ciLogs: failureContext,
            previousDiff: previousCodeResult.diff.slice(-20_000),
            previousTestResults: previousCodeResult.testResults,
          }),
        },
      ],
      { toolChoice: 'auto' },
    );

    heartbeat('CI fix agent completed');

    // Run tests locally after fix
    let testResult: TestRunResult;
    try {
      const startTime = Date.now();
      const testOutput = workspace.exec(testCommand);
      testResult = parseTestOutput(testOutput, Date.now() - startTime);
    } catch (err: any) {
      testResult = {
        passed: false,
        total: 0,
        passing: 0,
        failing: 1,
        stdout: err.stdout?.slice(-10_000) ?? err.message,
        duration_ms: 0,
      };
    }

    // Commit and push the fix
    workspace.exec('git add -A');
    workspace.exec(`git commit -m "auto: fix CI for ${previousCodeResult.branch}" --allow-empty`);
    workspace.exec(`git push origin '${previousCodeResult.branch}'`);

    const diff = workspace.exec(`git diff origin/${repo.defaultBranch}`);
    const headSha = workspace.exec('git rev-parse HEAD').trim();

    return {
      branch: previousCodeResult.branch,
      headSha,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      testResults: testResult,
      implementationNotes: `CI fix iteration. Failure context analyzed: ${failureContext.length} chars. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
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
  previousCodeResult: CodeResult,
): Promise<CodeResult> {
  const workflow = await prisma.activeWorkflow.findFirst({
    where: { assignedBranch: previousCodeResult.branch },
    include: { repository: true },
  });

  if (!workflow?.repository) {
    throw new Error(`No workflow found for branch ${previousCodeResult.branch}`);
  }

  const repo = workflow.repository;
  const githubUrl = repo.githubUrl ?? process.env.GITHUB_URL ?? 'https://github.com';
  const repoUrl = `${githubUrl}/${repo.organizationName}/${repo.repoName}.git`;
  const githubToken = process.env.GITHUB_TOKEN!;

  const workspace = createWorkspace(
    repoUrl,
    previousCodeResult.branch,
    repo.defaultBranch,
    githubToken,
    repo.executorImage ?? 'node:24-alpine',
  );

  try {
    heartbeat('review fix workspace provisioned');

    const packageJson = workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    const { agent } = createImplementerAgent(workspace);

    await agent.generate(
      [
        { role: 'system', content: REVIEW_FIX_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            mode: 'REVIEW_FIX',
            reviewFindings: rejectionSummary,
            previousDiff: previousCodeResult.diff.slice(-20_000),
            previousTestResults: previousCodeResult.testResults,
          }),
        },
      ],
      { toolChoice: 'auto' },
    );

    heartbeat('review fix agent completed');

    let testResult: TestRunResult;
    try {
      const startTime = Date.now();
      const testOutput = workspace.exec(testCommand);
      testResult = parseTestOutput(testOutput, Date.now() - startTime);
    } catch (err: any) {
      testResult = {
        passed: false,
        total: 0,
        passing: 0,
        failing: 1,
        stdout: err.stdout?.slice(-10_000) ?? err.message,
        duration_ms: 0,
      };
    }

    workspace.exec('git add -A');
    workspace.exec(`git diff --cached --quiet || git commit -m "auto: address review findings for ${previousCodeResult.branch}"`);
    workspace.exec(`git push origin '${previousCodeResult.branch}'`);

    const diff = workspace.exec(`git diff origin/${repo.defaultBranch}`);
    const headSha = workspace.exec('git rev-parse HEAD').trim();

    return {
      branch: previousCodeResult.branch,
      headSha,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      testResults: testResult,
      implementationNotes: `Review fix iteration. ${rejectionSummary.split('\n').length} findings addressed. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
    };
  } finally {
    workspace.destroy();
  }
}
