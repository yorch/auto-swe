import { prisma } from '@auto-swe/shared/db';
import { scanSkillContent } from '@auto-swe/shared/lib/skillScanner';
import {
  resolveIssueTrackerConfig,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import { syncTrackerOnEvent } from '@auto-swe/shared/lib/trackerSync';
import type {
  CodeResult,
  CodeSecurityFinding,
  RepoWorkRequest,
  Subtask,
  TestRunResult,
} from '@auto-swe/shared/types/workflow';
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { buildImplementerForActivity } from '../agents/implementer.js';
import { IMPLEMENTER_SYSTEM_PROMPT } from '../agents/prompts.js';
import { scanDiffForSecurityIssues } from '../agents/securityReviewProcessor.js';
import { currentWorkflowId, persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { scanDiffForCodeIssues } from '../lib/codeSecurityScanner.js';
import { currentRequestContext } from '../lib/config/contextLookup.js';
import { recordLlmUsage } from '../lib/costTracking.js';
import { getExecErrorStdout } from '../lib/errors.js';
import { retrieveSimilarLessons } from '../lib/lessonRetrieval.js';
import { resolveSystemPrompt } from '../lib/models.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { detectTestCommand, parseDiffToFileChanges, parseTestOutput } from './utils.js';
import { createWorkspace, shellQuote } from './workspace.js';

const MAX_TDD_ITERATIONS = 5;

// Compact shape of the Figma design summary stored on ContextSnapshot.rawDesign
// (see FigmaDesignSummary in @auto-swe/shared). Kept local to avoid a
// cross-package subpath import for a read-only projection.
interface DesignNodeSummary {
  name?: string;
  type?: string;
  childNames?: string[];
  texts?: string[];
}
interface DesignSummary {
  fileName?: string;
  url?: string;
  nodes?: DesignNodeSummary[];
  tokens?: { name: string; value: string }[];
  truncated?: boolean;
}

/**
 * Render the stored Figma design summary into a compact prompt block. Returns
 * '' when there is no usable design context. Bounded so it can never blow the
 * implementer's context budget regardless of design size.
 */
function formatDesignContext(rawDesign: unknown): string {
  if (!Array.isArray(rawDesign) || rawDesign.length === 0) {
    return '';
  }
  const summaries = rawDesign as DesignSummary[];
  const lines: string[] = [];
  for (const s of summaries.slice(0, 3)) {
    lines.push(`### ${s.fileName ?? 'Figma design'}${s.url ? ` (${s.url})` : ''}`);
    for (const node of (s.nodes ?? []).slice(0, 8)) {
      const children =
        node.childNames && node.childNames.length > 0
          ? ` — children: ${node.childNames.slice(0, 12).join(', ')}`
          : '';
      lines.push(`- **${node.name ?? 'node'}** (${node.type ?? 'NODE'})${children}`);
      const texts = (node.texts ?? []).slice(0, 8);
      if (texts.length > 0) {
        lines.push(`  text: ${texts.map((t) => JSON.stringify(t)).join(', ')}`);
      }
    }
    const tokens = (s.tokens ?? []).slice(0, 24);
    if (tokens.length > 0) {
      lines.push(`tokens: ${tokens.map((t) => `${t.name}=${t.value}`).join('; ')}`);
    }
    if (s.truncated) {
      lines.push('(design summary truncated)');
    }
  }
  if (lines.length === 0) {
    return '';
  }
  return `\n\n## Referenced Figma Design\nMatch the implementation to this design — see the *design-fidelity* skill.\n${lines.join('\n')}`;
}

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
  const repo = await prisma.connection.findUniqueOrThrow({
    where: { id: request.repoId },
  });

  const workflowDefaults = await resolveWorkflowDefaults();
  const featureBranch = `${workflowDefaults.branchPrefix}/${request.externalTicketId}`;
  const branch = subtask ? `${featureBranch}/${subtask.id}` : featureBranch;

  const repoRef = toRepoRef(repo);
  const { authedCloneUrl } = await getScmProvider(repoRef).cloneCredentials(repoRef);

  const workspace = await createWorkspace(
    authedCloneUrl,
    branch,
    repo.defaultBranch,
    repo.executorImage ?? 'node:24-alpine'
  );

  const tracer = new AgentTracer();
  // P2/WS3: present when the implementer Agent enabled MCP — closed in finally.
  let closeMcp: (() => Promise<void>) | undefined;

  try {
    heartbeat('workspace provisioned');

    // Detect test framework
    const packageJson = await workspace.exec('cat package.json 2>/dev/null || echo "{}"');
    const testCommand = detectTestCommand(packageJson);

    // Load tool config + skills (WORKFLOW_TEMPLATE → TEAM → GLOBAL cascade),
    // resolve any MCP server, and build the agent — bound to the workspace so
    // the tracer captures every call. promptSuffix carries prompt-fragment
    // skills to append to the system prompt.
    const activityCtx = await currentRequestContext();
    const {
      agent,
      promptSuffix,
      closeMcp: cm,
      skills,
    } = await buildImplementerForActivity(workspace, tracer, activityCtx);
    closeMcp = cm;

    tracer.addActivityEvent({
      name: 'skills.loaded',
      outputJson: { count: skills.length, skills: skills.map((s) => s.name) },
    });

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

    // Design context (P1): when the work request's snapshot carries a Figma
    // design summary, surface a compact description so the implementer can match
    // it. Best-effort — a read failure must not block implementation.
    let designContext = '';
    try {
      const snapshot = await prisma.contextSnapshot.findUnique({
        select: { rawDesign: true },
        where: { workRequestId: request.workRequestId },
      });
      designContext = formatDesignContext(snapshot?.rawDesign);
      if (designContext) {
        tracer.addActivityEvent({
          name: 'design.context_loaded',
          outputJson: { chars: designContext.length },
        });
      }
    } catch {
      // Design context is optional — never block implementation on it.
    }

    // Fire-and-forget tracker sync — never blocks implementation
    resolveIssueTrackerConfig()
      .then((trackerConfig) =>
        syncTrackerOnEvent(
          { issueId: request.externalTicketId, type: 'workflow_started' },
          trackerConfig
        )
      )
      .catch(() => null);

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

    const llmSystemPrompt =
      systemPrompt + (promptSuffix ? `\n\n${promptSuffix}` : '') + lessonsContext + designContext;

    // TDD loop
    for (let iteration = 0; iteration < MAX_TDD_ITERATIONS; iteration++) {
      heartbeat(`TDD iteration ${iteration + 1}/${MAX_TDD_ITERATIONS}`);

      const llmUserMessage = JSON.stringify({
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
      });
      const genResult = await agent.generate(
        [
          { content: llmSystemPrompt, role: 'system' },
          { content: llmUserMessage, role: 'user' },
        ],
        { toolChoice: 'auto' }
      );

      let attribution = { costUsd: 0, inputTokens: 0, modelSpec: '', outputTokens: 0 };
      if (genResult.usage) {
        attribution = await recordLlmUsage(
          currentWorkflowId(),
          'implementer',
          genResult.usage,
          `llm.implementer.iteration_${iteration}`
        );
      }

      // LLM output scanner — advisory, non-blocking. A DB/network failure here
      // must not abort the implementation activity.
      if (genResult.text) {
        try {
          const outputScan = await scanSkillContent(genResult.text);
          if (!outputScan.safe) {
            tracer.addActivityEvent({
              inputJson: { iteration },
              name: 'llm.suspicious_output',
              outputJson: { warnings: outputScan.warnings },
            });
          }
        } catch {
          // Scan failure is non-fatal — implementation continues without the advisory check
        }
      }

      // Always record the LLM call per TDD iteration, even when the model only
      // makes tool calls and produces no text output.
      tracer.addLlmResponse({
        costUsd: attribution.costUsd,
        durationMs: 0,
        inputJson: { iteration, systemPrompt: llmSystemPrompt, userMessage: llmUserMessage },
        inputTokens: attribution.inputTokens,
        model: attribution.modelSpec || undefined,
        outputJson: genResult.text
          ? { text: genResult.text }
          : { toolCallCount: genResult.steps?.length ?? 0 },
        outputTokens: attribution.outputTokens,
        role: 'implementer',
      });

      // Run tests
      const testStart = Date.now();
      try {
        const testOutput = await workspace.exec(testCommand);
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
    await workspace.exec('git add -A');
    await workspace.exec(`git commit -m ${shellQuote(commitSummary)}`);
    await workspace.exec(`git push origin ${shellQuote(branch)}`);

    // Collect results
    const diff = await workspace.exec(`git diff origin/${repo.defaultBranch}`);
    const headSha = (await workspace.exec('git rev-parse HEAD')).trim();

    tracer.addActivityEvent({
      name: 'git.commit_push',
      outputJson: { branch, commitMessage: commitSummary, headSha },
    });

    // Static code security scan — advisory findings passed to the review network.
    // Not blocking here; the security reviewer agent decides severity.
    const codeSecurityFindings: CodeSecurityFinding[] = await scanDiffForCodeIssues(diff);
    if (codeSecurityFindings.length > 0) {
      tracer.addActivityEvent({
        name: 'code_security.scan',
        outputJson: { count: codeSecurityFindings.length, findings: codeSecurityFindings },
      });
    }

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
      codeSecurityFindings: codeSecurityFindings.length > 0 ? codeSecurityFindings : undefined,
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      headSha,
      implementationNotes: `Completed in ${testResult.passed ? '≤5' : '5 (max)'} TDD iterations. Tests ${testResult.passed ? 'passing' : 'failing'}.`,
      repoId: request.repoId,
      testResults: testResult,
    };
  } finally {
    await closeMcp?.();
    await persistActivityTrace(tracer, 'implementer');
    await workspace.destroy();
  }
}
