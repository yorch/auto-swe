import { prisma } from '@auto-swe/shared/db';
import type { CodeResult, RepoWorkRequest, TestRunResult } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { createImplementerAgent } from '../agents/implementer.js';
import { IMPLEMENTER_SYSTEM_PROMPT } from '../agents/prompts.js';
import { scanDiffForSecurityIssues } from '../agents/securityReviewProcessor.js';
import { currentWorkflowId } from '../lib/activityContext.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { retrieveSimilarLessons } from '../lib/lessonRetrieval.js';
import { detectTestCommand, parseDiffToFileChanges, parseTestOutput } from './utils.js';
import { createWorkspace, shellQuote } from './workspace.js';

const MAX_TDD_ITERATIONS = 5;

export async function executeImplementation(request: RepoWorkRequest): Promise<CodeResult> {
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
    repo.executorImage ?? 'node:24-alpine'
  );

  try {
    heartbeat('workspace provisioned');

    // Detect test framework
    const packageJson = workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    // Create Mastra agent with tools bound to workspace
    const { agent } = createImplementerAgent(workspace);

    // Retrieve relevant lessons from past workflows for context enrichment
    let lessonsContext = '';
    try {
      const lessons = await retrieveSimilarLessons(request.description, request.repoId);
      if (lessons.length > 0) {
        lessonsContext =
          '\n\n## Lessons from Previous Workflows\n' +
          lessons.map((l) => `- [${l.failureType ?? 'GENERAL'}] ${l.summary}`).join('\n');
      }
    } catch {
      // Lesson retrieval failure should not block implementation
    }

    heartbeat('lessons retrieved');

    let testResult: TestRunResult = {
      duration_ms: 0,
      failing: 0,
      passed: false,
      passing: 0,
      stdout: '',
      total: 0,
    };

    // TDD loop
    for (let iteration = 0; iteration < MAX_TDD_ITERATIONS; iteration++) {
      heartbeat(`TDD iteration ${iteration + 1}/${MAX_TDD_ITERATIONS}`);

      const genResult = await agent.generate(
        [
          { content: IMPLEMENTER_SYSTEM_PROMPT + lessonsContext, role: 'system' },
          {
            content: JSON.stringify({
              description: request.description,
              externalTicketId: request.externalTicketId,
              iteration,
              previousTestResult: iteration > 0 ? testResult : undefined,
            }),
            role: 'user',
          },
        ],
        { toolChoice: 'auto' }
      );

      if (genResult.usage) {
        await recordLlmUsage(
          currentWorkflowId(),
          'implementer',
          genResult.usage,
          `llm.implementer.iteration_${iteration}`
        );
      }

      // Run tests
      try {
        const startTime = Date.now();
        const testOutput = workspace.exec(testCommand);
        testResult = parseTestOutput(testOutput, Date.now() - startTime);
        if (testResult.passed) break;
      } catch (err: any) {
        testResult = {
          duration_ms: 0,
          failing: 1,
          passed: false,
          passing: 0,
          stdout: err.stdout?.slice(-10_000) ?? err.message,
          total: 0,
        };
      }
    }

    // Commit and push
    workspace.exec('git add -A');
    workspace.exec(`git commit -m "auto: implement ${request.externalTicketId}"`);
    workspace.exec(`git push origin ${shellQuote(branch)}`);

    // Collect results
    const diff = workspace.exec(`git diff origin/${repo.defaultBranch}`);
    const headSha = workspace.exec('git rev-parse HEAD').trim();

    // Security scan — gate before returning code result
    heartbeat('running security scan');
    const securityResult = await scanDiffForSecurityIssues(diff);
    if (!securityResult.passed) {
      const findingsSummary = securityResult.findings
        .map(
          (f) =>
            `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} — ${f.category}: ${f.description}`
        )
        .join('\n');
      throw ApplicationFailure.nonRetryable(
        `Security scan failed with critical findings:\n${findingsSummary}`,
        'SECURITY_GATE_FAILURE',
        { findings: securityResult.findings }
      );
    }

    return {
      branch,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      headSha,
      implementationNotes: `Completed in ${testResult.passed ? '≤5' : '5 (max)'} TDD iterations. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
      testResults: testResult,
    };
  } finally {
    workspace.destroy();
  }
}
