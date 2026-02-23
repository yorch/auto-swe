import { heartbeat } from '@temporalio/activity';
import { prisma } from '@auto-swe/shared/db';
import type { RepoWorkRequest, CodeResult, TestRunResult } from '@auto-swe/shared/types/workflow';
import { createWorkspace } from './workspace.js';
import { createImplementerAgent } from '../agents/implementer.js';
import { IMPLEMENTER_SYSTEM_PROMPT } from '../agents/prompts.js';

const MAX_TDD_ITERATIONS = 5;

export async function executeImplementation(
  request: RepoWorkRequest,
): Promise<CodeResult> {
  const repo = await prisma.repository.findUniqueOrThrow({
    where: { id: request.repoId },
  });

  const githubUrl = repo.githubUrl ?? process.env.GITHUB_URL ?? 'https://github.com';
  const repoUrl = `${githubUrl}/${repo.organizationName}/${repo.repoName}.git`;
  const branchPrefix = process.env.BRANCH_PREFIX ?? 'auto';
  const branch = `${branchPrefix}/${request.externalTicketId}`;
  const githubToken = process.env.GITHUB_TOKEN!;

  const workspace = createWorkspace(
    repoUrl,
    branch,
    repo.defaultBranch,
    githubToken,
    repo.executorImage ?? 'node:24-alpine',
  );

  try {
    heartbeat('workspace provisioned');

    // Detect test framework
    const packageJson = workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    // Create Mastra agent with tools bound to workspace
    const { agent } = createImplementerAgent(workspace);

    let testResult: TestRunResult = {
      passed: false, total: 0, passing: 0, failing: 0, stdout: '', duration_ms: 0,
    };

    // TDD loop
    for (let iteration = 0; iteration < MAX_TDD_ITERATIONS; iteration++) {
      heartbeat(`TDD iteration ${iteration + 1}/${MAX_TDD_ITERATIONS}`);

      await agent.generate(
        [
          { role: 'system', content: IMPLEMENTER_SYSTEM_PROMPT },
          {
            role: 'user',
            content: JSON.stringify({
              description: request.description,
              externalTicketId: request.externalTicketId,
              iteration,
              previousTestResult: iteration > 0 ? testResult : undefined,
            }),
          },
        ],
        { toolChoice: 'auto' },
      );

      // Run tests
      try {
        const startTime = Date.now();
        const testOutput = workspace.exec(testCommand);
        testResult = parseTestOutput(testOutput, Date.now() - startTime);
        if (testResult.passed) break;
      } catch (err: any) {
        testResult = {
          passed: false, total: 0, passing: 0, failing: 1,
          stdout: err.stdout?.slice(-10_000) ?? err.message,
          duration_ms: 0,
        };
      }
    }

    // Commit and push
    workspace.exec('git add -A');
    workspace.exec(`git commit -m "auto: implement ${request.externalTicketId}"`);
    workspace.exec(`git push origin '${branch}'`);

    // Collect results
    const diff = workspace.exec(`git diff origin/${repo.defaultBranch}`);
    const headSha = workspace.exec('git rev-parse HEAD').trim();

    return {
      branch,
      headSha,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      testResults: testResult,
      implementationNotes: `Completed in ${formatIterationCount(testResult)} TDD iterations. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
    };
  } finally {
    workspace.destroy();
  }
}

function formatIterationCount(result: TestRunResult): string {
  return result.passed ? '≤5' : '5 (max)';
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
