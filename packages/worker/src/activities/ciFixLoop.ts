import { heartbeat } from '@temporalio/activity';
import { prisma } from '@auto-swe/shared/db';
import type { CodeResult, TestRunResult } from '@auto-swe/shared/types/workflow';
import { createWorkspace } from './workspace.js';
import { createImplementerAgent } from '../agents/implementer.js';
import { CI_FIX_SYSTEM_PROMPT } from '../agents/prompts.js';

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
  // Look up the repo from the branch name
  const branchPrefix = process.env.BRANCH_PREFIX ?? 'auto';
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

function detectTestCommand(packageJsonStr: string): string {
  try {
    const pkg = JSON.parse(packageJsonStr);
    if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
      return 'npm test';
    }
  } catch {}
  return 'npm test';
}

function parseTestOutput(output: string, durationMs: number): TestRunResult {
  const passMatch = output.match(/(\d+)\s+pass/i);
  const failMatch = output.match(/(\d+)\s+fail/i);
  const passing = passMatch ? parseInt(passMatch[1]) : 0;
  const failing = failMatch ? parseInt(failMatch[1]) : 0;

  return {
    passed: failing === 0 && passing > 0,
    total: passing + failing,
    passing,
    failing,
    stdout: output.slice(-10_000),
    duration_ms: durationMs,
  };
}

function parseDiffToFileChanges(diff: string) {
  const files: { path: string; operation: 'CREATE' | 'MODIFY' | 'DELETE'; language: string; linesAdded: number; linesRemoved: number }[] = [];
  const fileRegex = /^diff --git a\/(.+) b\/(.+)$/gm;
  let match;
  while ((match = fileRegex.exec(diff)) !== null) {
    const path = match[2];
    const ext = path.split('.').pop() ?? '';
    const section = diff.slice(match.index, diff.indexOf('diff --git', match.index + 1) === -1 ? undefined : diff.indexOf('diff --git', match.index + 1));
    const added = (section.match(/^\+[^+]/gm) || []).length;
    const removed = (section.match(/^-[^-]/gm) || []).length;
    const isNew = section.includes('new file mode');
    const isDeleted = section.includes('deleted file mode');

    files.push({
      path,
      operation: isNew ? 'CREATE' : isDeleted ? 'DELETE' : 'MODIFY',
      language: ext,
      linesAdded: added,
      linesRemoved: removed,
    });
  }
  return files;
}
