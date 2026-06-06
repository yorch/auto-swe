import { prisma } from '@auto-swe/shared/db';
import { resolveGitHubConfig, resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import type {
  CodeResult,
  RepoWorkRequest,
  Subtask,
  TestRunResult,
} from '@auto-swe/shared/types/workflow';
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { createImplementerAgent } from '../agents/implementer.js';
import { IMPLEMENTER_SYSTEM_PROMPT } from '../agents/prompts.js';
import { scanDiffForSecurityIssues } from '../agents/securityReviewProcessor.js';
import { currentWorkflowId, persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { loadAgentSkills, loadAgentToolConfig } from '../lib/config/agentSkills.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { getExecErrorStdout } from '../lib/errors.js';
import { requireGitHubToken } from '../lib/githubAuth.js';
import { retrieveSimilarLessons } from '../lib/lessonRetrieval.js';
import { resolveSystemPrompt } from '../lib/models.js';
import { detectTestCommand, parseDiffToFileChanges, parseTestOutput } from './utils.js';
import { createWorkspace, shellQuote } from './workspace.js';

const MAX_TDD_ITERATIONS = 5;

/**
 * Run the implementer agent for a work request.
 *
 * When `subtask` is supplied (phase-3 fan-out), the activity:
 *   - uses a sub-branch `<BRANCH_PREFIX>/<ticket>/<subtask.id>`
 *   - injects the subtask description into the implementer's user message
 *     in place of the full work-request description
 *
 * Subtask branches are merged back into the parent feature branch by the
 * `mergeBranches` activity before the final PR is opened.
 */
// Note: toolsOverride parameter was removed — tool selection is superseded by
// DB-driven AgentSkillAssignment rows (WORKFLOW_TEMPLATE → TEAM → GLOBAL cascade).
export async function executeImplementation(
  request: RepoWorkRequest,
  subtask?: Subtask,
  systemPromptOverride?: string
): Promise<CodeResult> {
  const repo = await prisma.repository.findUniqueOrThrow({
    where: { id: request.repoId },
  });

  const [ghConfig, workflowDefaults] = await Promise.all([
    resolveGitHubConfig(),
    resolveWorkflowDefaults(),
  ]);
  const githubUrl = repo.githubUrl ?? ghConfig.baseUrl;
  const repoUrl = `${githubUrl}/${repo.organizationName}/${repo.repoName}.git`;
  const featureBranch = `${workflowDefaults.branchPrefix}/${request.externalTicketId}`;
  const branch = subtask ? `${featureBranch}/${subtask.id}` : featureBranch;
  const githubToken = await requireGitHubToken(ghConfig);

  const workspace = createWorkspace(
    repoUrl,
    branch,
    repo.defaultBranch,
    githubToken,
    repo.executorImage ?? 'node:24-alpine'
  );

  const tracer = new AgentTracer();

  try {
    heartbeat('workspace provisioned');

    // Detect test framework
    const packageJson = workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    // Load tool config and skills for this role at the current scope
    // (WORKFLOW_TEMPLATE → TEAM → GLOBAL cascade for both).
    const activityCtx = await currentRequestContext();
    const [toolConfig, skills] = await Promise.all([
      loadAgentToolConfig('implementer', activityCtx),
      loadAgentSkills('implementer', activityCtx),
    ]);

    // Create Mastra agent with tools bound to workspace (tracer captures every call).
    // promptSuffix contains any prompt-fragment skills to be appended to the system prompt.
    const { agent, promptSuffix } = await createImplementerAgent(
      workspace,
      tracer,
      toolConfig,
      skills
    );

    // Retrieve relevant lessons from past workflows for context enrichment
    let lessonsContext = '';
    try {
      const lessons = await retrieveSimilarLessons(request.description, request.repoId);
      if (lessons.length > 0) {
        lessonsContext =
          '\n\n## Lessons from Previous Workflows\n' +
          lessons.map((l) => `- [${l.failureType ?? 'GENERAL'}] ${l.summary}`).join('\n');
        tracer.addActivityEvent({
          name: 'lessons.retrieved',
          outputJson: {
            count: lessons.length,
            lessons: lessons.map((l) => ({ failureType: l.failureType, summary: l.summary })),
          },
        });
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

    const systemPrompt = await resolveSystemPrompt(
      'implementer',
      IMPLEMENTER_SYSTEM_PROMPT,
      systemPromptOverride
    );

    // TDD loop
    for (let iteration = 0; iteration < MAX_TDD_ITERATIONS; iteration++) {
      heartbeat(`TDD iteration ${iteration + 1}/${MAX_TDD_ITERATIONS}`);

      const genResult = await agent.generate(
        [
          {
            content: systemPrompt + (promptSuffix ? `\n\n${promptSuffix}` : '') + lessonsContext,
            role: 'system',
          },
          {
            content: JSON.stringify({
              description: subtask?.description ?? request.description,
              externalTicketId: request.externalTicketId,
              iteration,
              previousTestResult: iteration > 0 ? testResult : undefined,
              ...(subtask
                ? {
                    fileScope: subtask.files,
                    subtaskId: subtask.id,
                    subtaskTitle: subtask.title,
                  }
                : {}),
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

      // Record implementer's reasoning text (the LLM response between tool calls)
      if (genResult.text) {
        tracer.addLlmResponse({
          durationMs: 0,
          inputJson: { iteration },
          outputJson: { text: genResult.text },
          role: 'implementer',
        });
      }

      // Run tests
      const testStart = Date.now();
      try {
        const testOutput = workspace.exec(testCommand);
        testResult = parseTestOutput(testOutput, Date.now() - testStart);
        tracer.addActivityEvent({
          durationMs: Date.now() - testStart,
          inputJson: { iteration },
          name: 'tdd.test_run',
          outputJson: {
            failing: testResult.failing,
            passed: testResult.passed,
            passing: testResult.passing,
            total: testResult.total,
          },
        });
        if (testResult.passed) {
          break;
        }
      } catch (err: unknown) {
        testResult = {
          duration_ms: 0,
          failing: 1,
          passed: false,
          passing: 0,
          stdout: getExecErrorStdout(err),
          total: 0,
        };
        tracer.addActivityEvent({
          error: getExecErrorStdout(err).slice(0, 1000),
          inputJson: { iteration },
          name: 'tdd.test_run',
          outputJson: { passed: false },
        });
      }
    }

    // Commit and push
    const commitSummary = subtask
      ? `auto: ${subtask.id} — ${subtask.title} (${request.externalTicketId})`
      : `auto: implement ${request.externalTicketId}`;
    workspace.exec('git add -A');
    workspace.exec(`git commit -m ${shellQuote(commitSummary)}`);
    workspace.exec(`git push origin ${shellQuote(branch)}`);

    // Collect results
    const diff = workspace.exec(`git diff origin/${repo.defaultBranch}`);
    const headSha = workspace.exec('git rev-parse HEAD').trim();

    tracer.addActivityEvent({
      name: 'git.commit_push',
      outputJson: { branch, commitMessage: commitSummary, headSha },
    });

    // Persist traces before the security gate so they survive a gate rejection.
    await persistActivityTrace(tracer, 'implementer');

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
