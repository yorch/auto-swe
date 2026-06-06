import { prisma } from '@auto-swe/shared/db';
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import type { CodeResult, TestRunResult } from '@auto-swe/shared/types/workflow';
import { heartbeat } from '@temporalio/activity';
import { createImplementerAgent } from '../agents/implementer.js';
import { CI_FIX_SYSTEM_PROMPT, REVIEW_FIX_SYSTEM_PROMPT } from '../agents/prompts.js';
import { currentWorkflowId, persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { loadAgentSkills } from '../lib/config/agentSkills.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { getExecErrorStdout } from '../lib/errors.js';
import { resolveSystemPrompt } from '../lib/models.js';
import { detectTestCommand, parseDiffToFileChanges, parseTestOutput } from './utils.js';
import { createWorkspace, shellQuote } from './workspace.js';

/**
 * Fetches CI logs from the provided URL.
 * Truncates to last 50KB to fit in LLM context.
 */
export async function fetchCILogs(logsUrl?: string): Promise<string> {
  if (!logsUrl) {
    return 'No logs URL provided by CI webhook';
  }

  const { token: githubToken } = await resolveGitHubConfig();
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
 * agent in CI fix mode with the failure logs injected.
 */
export async function executeCIFixImplementation(
  failureContext: string,
  previousCodeResult: CodeResult,
  systemPromptOverride?: string
): Promise<CodeResult> {
  const workflow = await prisma.activeWorkflow.findFirst({
    include: { repository: true },
    where: { assignedBranch: previousCodeResult.branch },
  });

  if (!workflow?.repository) {
    throw new Error(`No workflow found for branch ${previousCodeResult.branch}`);
  }

  const repo = workflow.repository;
  const ghConfig = await resolveGitHubConfig();
  const githubUrl = repo.githubUrl ?? ghConfig.baseUrl;
  const repoUrl = `${githubUrl}/${repo.organizationName}/${repo.repoName}.git`;
  if (!ghConfig.token) {
    throw new Error('GitHub token not configured. Set it at /admin/integrations.');
  }
  const githubToken = ghConfig.token;

  // Provision workspace and checkout the existing branch
  const workspace = createWorkspace(
    repoUrl,
    previousCodeResult.branch,
    repo.defaultBranch,
    githubToken,
    repo.executorImage ?? 'node:24-alpine'
  );

  const tracer = new AgentTracer();

  try {
    heartbeat('CI fix workspace provisioned');

    // Detect test framework
    const packageJson = workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    const activityCtx = await currentRequestContext();
    const skills = await loadAgentSkills('implementer', activityCtx);
    const { agent, promptSuffix } = await createImplementerAgent(workspace, tracer, skills);

    const systemPrompt = await resolveSystemPrompt(
      'implementer',
      CI_FIX_SYSTEM_PROMPT,
      systemPromptOverride
    );

    // Run the agent in CI fix mode
    const agentStart = Date.now();
    const ciFix = await agent.generate(
      [
        { content: systemPrompt + (promptSuffix ? `\n\n${promptSuffix}` : ''), role: 'system' },
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

    if (ciFix.text) {
      tracer.addLlmResponse({
        durationMs: Date.now() - agentStart,
        outputJson: { text: ciFix.text },
        role: 'implementer',
      });
    }

    // Run tests locally after fix
    let testResult: TestRunResult;
    const testStart = Date.now();
    try {
      const testOutput = workspace.exec(testCommand);
      testResult = parseTestOutput(testOutput, Date.now() - testStart);
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
    tracer.addActivityEvent({
      durationMs: Date.now() - testStart,
      name: 'tdd.test_run',
      outputJson: {
        failing: testResult.failing,
        passed: testResult.passed,
        passing: testResult.passing,
        total: testResult.total,
      },
    });

    // Commit and push the fix (skip if agent made no changes to avoid empty CI cycles)
    workspace.exec('git add -A');
    workspace.exec(
      `git diff --cached --quiet || git commit -m ${shellQuote(`auto: fix CI for ${previousCodeResult.branch}`)}`
    );
    workspace.exec(`git push origin ${shellQuote(previousCodeResult.branch)}`);

    const diff = workspace.exec(`git diff origin/${repo.defaultBranch}`);
    const headSha = workspace.exec('git rev-parse HEAD').trim();

    tracer.addActivityEvent({
      name: 'git.commit_push',
      outputJson: { branch: previousCodeResult.branch, headSha },
    });

    return {
      branch: previousCodeResult.branch,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      headSha,
      implementationNotes: `CI fix iteration. Failure context analyzed: ${failureContext.length} chars. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
      testResults: testResult,
    };
  } finally {
    const done = persistActivityTrace(tracer, 'implementer');
    workspace.destroy();
    await done;
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
  systemPromptOverride?: string
): Promise<CodeResult> {
  const workflow = await prisma.activeWorkflow.findFirst({
    include: { repository: true },
    where: { assignedBranch: previousCodeResult.branch },
  });

  if (!workflow?.repository) {
    throw new Error(`No workflow found for branch ${previousCodeResult.branch}`);
  }

  const repo = workflow.repository;
  const ghConfig = await resolveGitHubConfig();
  const githubUrl = repo.githubUrl ?? ghConfig.baseUrl;
  const repoUrl = `${githubUrl}/${repo.organizationName}/${repo.repoName}.git`;
  if (!ghConfig.token) {
    throw new Error('GitHub token not configured. Set it at /admin/integrations.');
  }
  const githubToken = ghConfig.token;

  const workspace = createWorkspace(
    repoUrl,
    previousCodeResult.branch,
    repo.defaultBranch,
    githubToken,
    repo.executorImage ?? 'node:24-alpine'
  );

  const reviewTracer = new AgentTracer();

  try {
    heartbeat('review fix workspace provisioned');

    const packageJson = workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    const activityCtx = await currentRequestContext();
    const skills = await loadAgentSkills('implementer', activityCtx);
    const { agent, promptSuffix } = await createImplementerAgent(workspace, reviewTracer, skills);

    const reviewSystemPrompt = await resolveSystemPrompt(
      'implementer',
      REVIEW_FIX_SYSTEM_PROMPT,
      systemPromptOverride
    );

    const agentStart = Date.now();
    const reviewFix = await agent.generate(
      [
        {
          content: reviewSystemPrompt + (promptSuffix ? `\n\n${promptSuffix}` : ''),
          role: 'system',
        },
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

    if (reviewFix.text) {
      reviewTracer.addLlmResponse({
        durationMs: Date.now() - agentStart,
        outputJson: { text: reviewFix.text },
        role: 'implementer',
      });
    }

    let testResult: TestRunResult;
    const testStart = Date.now();
    try {
      const testOutput = workspace.exec(testCommand);
      testResult = parseTestOutput(testOutput, Date.now() - testStart);
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
    reviewTracer.addActivityEvent({
      durationMs: Date.now() - testStart,
      name: 'tdd.test_run',
      outputJson: {
        failing: testResult.failing,
        passed: testResult.passed,
        passing: testResult.passing,
        total: testResult.total,
      },
    });

    workspace.exec('git add -A');
    workspace.exec(
      `git diff --cached --quiet || git commit -m ${shellQuote(`auto: address review findings for ${previousCodeResult.branch}`)}`
    );
    workspace.exec(`git push origin ${shellQuote(previousCodeResult.branch)}`);

    const diff = workspace.exec(`git diff origin/${repo.defaultBranch}`);
    const headSha = workspace.exec('git rev-parse HEAD').trim();

    reviewTracer.addActivityEvent({
      name: 'git.commit_push',
      outputJson: { branch: previousCodeResult.branch, headSha },
    });

    return {
      branch: previousCodeResult.branch,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      headSha,
      implementationNotes: `Review fix iteration. ${rejectionSummary.split('\n').length} findings addressed. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
      testResults: testResult,
    };
  } finally {
    const done = persistActivityTrace(reviewTracer, 'implementer');
    workspace.destroy();
    await done;
  }
}
