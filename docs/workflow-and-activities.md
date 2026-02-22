# Workflow & Activity Implementations

> Extracted from [PLAN.md](../PLAN.md) — Technical implementation detail for the Temporal worker.

## 1. Agent-to-Agent Data Flow & Typed Interfaces

Every handoff between agents uses a typed interface. No agent receives raw, unstructured output from a predecessor — all inter-agent communication is serialized JSON conforming to these TypeScript types.

```typescript
// ── Workflow Input ──

interface RepoWorkRequest {
  workRequestId: string;           // UUID from WorkRequest table
  repoId: string;                  // UUID from Repository table
  contextSnapshotId: string;       // UUID — immutable snapshot created by Context Validator
  planOverride?: string;           // Optional pre-approved plan (skips Planner)
  slackChannel?: string;           // For audit trail notifications
  parentWorkflowId?: string;       // Set when spawned by Epic Orchestrator
}

// ── Context Validator → Planner ──

interface ContextSnapshot {
  id: string;
  workRequestId: string;
  rawJiraEpic: Record<string, unknown> | null;
  rawConfluence: Record<string, unknown> | null;
  successCriteria: string[];       // Extracted acceptance criteria (immutable once persisted)
  relevantFilePaths: string[];     // Files identified as impacted by the change
  apiContracts: ApiContract[];     // Cross-repo contracts that must be preserved
  historicalLessons: LessonSummary[]; // Retrieved from pgvector similarity search
}

interface ApiContract {
  sourceRepo: string;
  endpoint: string;
  method: string;
  requestSchema: Record<string, unknown>;  // JSON Schema
  responseSchema: Record<string, unknown>;
}

interface LessonSummary {
  lessonId: string;
  summary: string;
  failureType: string;             // 'CI_FAILURE' | 'REVIEW_REJECTION' | 'SECURITY_VIOLATION' | 'MERGE_CONFLICT'
  similarity: number;              // Cosine similarity score (0-1)
}

// ── Planner → Implementer ──

interface ExecutionPlan {
  planId: string;
  steps: PlanStep[];
  testStrategy: TestStrategy;
  estimatedFiles: string[];        // Files the implementer should touch
  constraints: string[];           // Derived from successCriteria + security guidelines
}

interface PlanStep {
  order: number;
  description: string;             // Human-readable instruction
  targetFiles: string[];           // Specific file paths
  operation: 'CREATE' | 'MODIFY' | 'DELETE';
  rationale: string;               // Why this step is necessary
  dependsOn: number[];             // References to prior step `order` values
}

interface TestStrategy {
  framework: string;               // 'jest' | 'pytest' | 'go test' | etc. (detected from repo)
  testFiles: string[];             // Where tests should be written
  coverageTargets: string[];       // Functions/modules that must be covered
  runCommand: string;              // e.g., 'npm run test', 'pytest -x'
}

// ── Implementer → Review Network ──

interface CodeResult {
  branch: string;                  // Git branch name (e.g., 'auto/JIRA-1234')
  headSha: string;                 // Latest commit SHA
  diff: string;                    // Unified diff of all changes
  filesChanged: FileChange[];
  testResults: TestRunResult;
  implementationNotes: string;     // Agent's rationale for key decisions
}

interface FileChange {
  path: string;
  operation: 'CREATE' | 'MODIFY' | 'DELETE';
  language: string;
  linesAdded: number;
  linesRemoved: number;
}

interface TestRunResult {
  passed: boolean;
  total: number;
  passing: number;
  failing: number;
  stdout: string;                  // Truncated to 10KB
  duration_ms: number;
}

// ── Review Network (each reviewer produces a ReviewVerdict) ──

interface ReviewVerdict {
  reviewer: 'SECURITY' | 'DOMAIN_LOGIC' | 'PERFORMANCE';
  approved: boolean;
  severity: 'PASS' | 'INFO' | 'WARNING' | 'CRITICAL';
  findings: ReviewFinding[];
}

interface ReviewFinding {
  file: string;
  line?: number;
  category: string;                // e.g., 'SQL_INJECTION', 'MISSING_EDGE_CASE', 'O(N^2)_LOOP'
  description: string;
  suggestedFix: string;            // Imperative instruction for the Implementer
}

interface AggregatedReviewResult {
  approved: boolean;               // true only if ALL reviewers approve
  verdicts: ReviewVerdict[];
  codeResult: CodeResult;          // Passed through for PR creation
  rejectionSummary?: string;       // Concatenated critical findings for Implementer retry
}

// ── Workflow Output ──

interface WorkflowResult {
  status: 'SUCCESS' | 'FAILED' | 'TIMED_OUT';
  prNumber?: number;
  prUrl?: string;
  totalCIRetries: number;
  totalReviewRetries: number;
  apiContractsChanged: boolean;
  lessonsGenerated: string[];      // UUIDs of AgentLesson records created
}
```

**Data flow summary:**

```
WorkRequest
  → Context Validator  →  ContextSnapshot
  → Planner Agent      →  ExecutionPlan
  → Implementer Agent  →  CodeResult
  → Review Network     →  AggregatedReviewResult
       ├─ (approved)   →  createOrUpdatePullRequest → await CI → await human merge
       └─ (rejected)   →  CodeResult fed back to Implementer with rejectionSummary
  → Memory Agent       →  AgentLesson (persisted with embedding)
```

## 2. The Epic Orchestrator (Parent Workflow)

The gateway triggers this master workflow. It evaluates global impact, orchestrates the dependency graph, and waits for all child repos to be successfully merged by human engineers.

## 3. The Repo-Specific Workflow (Child Workflow with CI/CD & TDD)

This is the standard, isolated agent loop that operates strictly within the confines of a single repository.

```typescript
import { workflowInfo, defineSignal, setHandler, condition, proxyActivities } from '@temporalio/workflow';
import type * as activitiesType from './activities';

// ── Activity Proxies with Retry Policies & Timeouts ──

// Short-lived, idempotent DB writes. Retry aggressively on transient failures.
const stateActivities = proxyActivities<Pick<typeof activitiesType,
  'updateDomainState' | 'postSlackThreadAudit' | 'notifyHumanGate'
>>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 5, initialInterval: '1s', backoffCoefficient: 2, maximumInterval: '30s' },
});

// Long-running LLM agent loops. Must heartbeat to prove liveness.
// Single attempt — retries are handled internally by the TDD loop.
const agentActivities = proxyActivities<Pick<typeof activitiesType,
  'executeImplementation' | 'executeCIFixImplementation' | 'runReviewNetwork'
>>({
  startToCloseTimeout: '30m',     // Agent may run multiple TDD iterations
  heartbeatTimeout: '5m',         // If no heartbeat for 5m, assume agent is stuck
  retry: { maximumAttempts: 2, initialInterval: '30s', backoffCoefficient: 2, maximumInterval: '2m' },
});

// GitHub API calls. Moderate timeout, retry on rate limits (HTTP 429).
const githubActivities = proxyActivities<Pick<typeof activitiesType,
  'createOrUpdatePullRequest' | 'fetchCILogs'
>>({
  startToCloseTimeout: '2m',
  retry: { maximumAttempts: 4, initialInterval: '5s', backoffCoefficient: 3, maximumInterval: '2m' },
});

// Memory commit. Involves LLM summarization + embedding generation + DB write.
const memoryActivities = proxyActivities<Pick<typeof activitiesType, 'commitToMemory'>>({
  startToCloseTimeout: '5m',
  retry: { maximumAttempts: 3, initialInterval: '5s', backoffCoefficient: 2, maximumInterval: '1m' },
});

// ── Workflow Signals ──

export const ciPipelineSignal = defineSignal<{ passed: boolean, logsUrl?: string }>('ciPipelineSignal');
export const humanMergeSignal = defineSignal<boolean>('humanMergeSignal');

// ── Workflow Constants ──

const MAX_CI_RETRIES = 3;           // Max times the agent will attempt to fix CI failures
const MAX_REVIEW_RETRIES = 3;       // Max times code cycles through the review network
const CI_SIGNAL_TIMEOUT = '4h';     // Max wait for CI pipeline to report back
const HUMAN_MERGE_TIMEOUT = '7d';   // Max wait for a human to merge the PR

// ── Workflow Implementation ──

export async function EngineeringWorkflow(request: RepoWorkRequest): Promise<WorkflowResult> {
  const { workflowId, parent } = workflowInfo();
  let ciResult: { passed: boolean, logsUrl?: string } | null = null;
  let humanMerged = false;
  let totalCIRetries = 0;
  let totalReviewRetries = 0;

  setHandler(ciPipelineSignal, (payload) => { ciResult = payload; });
  setHandler(humanMergeSignal, () => { humanMerged = true; });

  await stateActivities.updateDomainState(workflowId, 'IMPLEMENTING', request.repoId);

  // 1. Implementation Phase (Includes local TDD Loop)
  let codeResult = await agentActivities.executeImplementation(request.planOverride, request.contextSnapshotId);

  let isReadyForMerge = false;

  while (!isReadyForMerge) {
      await stateActivities.updateDomainState(workflowId, 'IN_REVIEW', request.repoId);

      // 2. Internal Review Loop
      const reviewResult = await agentActivities.runReviewNetwork(codeResult, request.contextSnapshotId);

      if (!reviewResult.approved) {
          totalReviewRetries++;
          if (totalReviewRetries >= MAX_REVIEW_RETRIES) {
              await stateActivities.notifyHumanGate(request.slackChannel, 'Review network rejected code after max retries. Manual intervention required.', 'PR_READY');
              return { status: 'FAILED', totalCIRetries, totalReviewRetries, apiContractsChanged: false, lessonsGenerated: [] };
          }
          // Feed rejection back to implementer
          codeResult = await agentActivities.executeCIFixImplementation(reviewResult.rejectionSummary!, codeResult);
          continue;
      }

      // 3. Open PR & Await External CI/CD Pipeline
      await stateActivities.updateDomainState(workflowId, 'AWAITING_CI', request.repoId);
      const prData = await githubActivities.createOrUpdatePullRequest(reviewResult);

      // Wait for CI signal with timeout
      const ciSignalReceived = await condition(() => ciResult !== null, CI_SIGNAL_TIMEOUT);
      if (!ciSignalReceived) {
          await stateActivities.postSlackThreadAudit(workflowId, '⏰ CI pipeline did not report within timeout. Marking as failed.');
          return { status: 'TIMED_OUT', prNumber: prData.prNumber, totalCIRetries, totalReviewRetries, apiContractsChanged: false, lessonsGenerated: [] };
      }

      if (ciResult!.passed) {
          isReadyForMerge = true;
      } else {
          totalCIRetries++;
          if (totalCIRetries >= MAX_CI_RETRIES) {
              await stateActivities.postSlackThreadAudit(workflowId, `❌ CI failed ${MAX_CI_RETRIES} times. Escalating to human.`);
              return { status: 'FAILED', prNumber: prData.prNumber, totalCIRetries, totalReviewRetries, apiContractsChanged: false, lessonsGenerated: [] };
          }
          // 4. CI/CD Fix Loop
          await stateActivities.postSlackThreadAudit(workflowId, `❌ External CI failed (attempt ${totalCIRetries}/${MAX_CI_RETRIES}). Reading logs and retrying...`);
          const failedLogs = await githubActivities.fetchCILogs(ciResult!.logsUrl);
          codeResult = await agentActivities.executeCIFixImplementation(failedLogs, codeResult);
          ciResult = null;
      }
  }

  // 5. Hand-off to Human Engineers
  await stateActivities.updateDomainState(workflowId, 'AWAITING_HUMAN_MERGE', request.repoId);
  await stateActivities.notifyHumanGate(request.slackChannel, 'PR is green and awaiting human review/merge.', 'PR_READY');

  // Wait for human merge with timeout
  const merged = await condition(() => humanMerged === true, HUMAN_MERGE_TIMEOUT);
  if (!merged) {
      await stateActivities.postSlackThreadAudit(workflowId, '⏰ PR was not merged within 7 days. Workflow expired.');
      return { status: 'TIMED_OUT', totalCIRetries, totalReviewRetries, apiContractsChanged: false, lessonsGenerated: [] };
  }

  // 6. Memory Commit
  await memoryActivities.commitToMemory(workflowId, request.repoId);

  await stateActivities.updateDomainState(workflowId, 'COMPLETED', request.repoId);
  return { status: 'SUCCESS', apiContractsChanged: true, totalCIRetries, totalReviewRetries, lessonsGenerated: [] };
}
```

**Retry & timeout strategy summary:**

| Activity Category | Timeout | Heartbeat | Max Attempts | Rationale |
|---|---|---|---|---|
| State updates (DB writes, Slack) | 30s | — | 5 | Idempotent, fast. Retry aggressively on transient DB/network errors. |
| Agent loops (implementation, review) | 30m | 5m heartbeat | 2 | Long-running LLM calls. Heartbeat detects stuck agents. Internal TDD loop handles code-level retries. |
| GitHub API (PR creation, log fetch) | 2m | — | 4 | Rate limits (429) are common. Exponential backoff with 3x coefficient accommodates GitHub's reset windows. |
| Memory commit (summarize + embed) | 5m | — | 3 | Involves LLM call + embedding API + DB write. Moderate retry for transient failures. |

**Workflow-level safety bounds:**

| Bound | Value | Behavior on Breach |
|---|---|---|
| Max CI retries | 3 | Workflow fails, escalates to human via Slack |
| Max review retries | 3 | Workflow fails, escalates to human via Slack |
| CI signal timeout | 4 hours | Workflow times out with TIMED_OUT status |
| Human merge timeout | 7 days | Workflow expires with TIMED_OUT status |

## 4. Activity Implementations

Each activity referenced by the workflow is a Temporal activity function executed by the worker process. Activities are the boundary between Temporal's deterministic replay and the non-deterministic outside world (LLM calls, Docker, GitHub API, database writes).

### `executeImplementation` — The Core Agent Loop

This is the most complex activity. It provisions a sandboxed workspace, runs the Mastra agent network, and returns a `CodeResult`.

```typescript
// activities/executeImplementation.ts
import { Mastra } from '@mastra/core';
import { k8sClient } from '../infra/k8s';
import { prisma } from '../db';

export async function executeImplementation(
  planOverride: string | undefined,
  contextSnapshotId: string
): Promise<CodeResult> {
  // 1. Load context snapshot + repository config
  const snapshot = await prisma.contextSnapshot.findUniqueOrThrow({
    where: { id: contextSnapshotId },
    include: { workRequest: { include: { activeWorkflows: { include: { repository: true } } } } }
  });
  const repo = snapshot.workRequest.activeWorkflows[0].repository!;

  // 2. Retrieve relevant historical lessons via pgvector similarity search
  const lessons = await retrieveSimilarLessons(snapshot.successCriteria.join(' '), repo.id);

  // 3. Provision isolated workspace (K8s Job with custom executor image)
  const workspace = await k8sClient.createJob({
    image: repo.executorImage ?? 'node:20-alpine',
    command: ['sleep', 'infinity'],  // Kept alive for agent tool calls
    volumes: [{ name: 'workspace', mountPath: '/workspace/target-repo' }],
    env: {
      GITHUB_TOKEN: await generateScopedInstallationToken(repo),
      REPO_URL: `https://github.com/${repo.organizationName}/${repo.repoName}.git`,
      BRANCH: `auto/${snapshot.workRequest.externalTicketId}`,
    },
  });

  try {
    // 4. Clone repo into workspace
    await workspace.exec('git', ['clone', '--depth=50', '-b', repo.defaultBranch, '$REPO_URL', '.']);
    await workspace.exec('git', ['checkout', '-b', '$BRANCH']);

    // 5. Run Planner Agent (if no plan override provided)
    const plan: ExecutionPlan = planOverride
      ? JSON.parse(planOverride)
      : await runPlannerAgent(snapshot, lessons);

    // 6. Run Implementer Agent with TDD loop
    const mastra = new Mastra({ /* agent config */ });
    const implementer = mastra.getAgent('implementer');

    let testResult: TestRunResult = { passed: false, total: 0, passing: 0, failing: 0, stdout: '', duration_ms: 0 };
    let iteration = 0;
    const MAX_TDD_ITERATIONS = 5;

    while (!testResult.passed && iteration < MAX_TDD_ITERATIONS) {
      // Implementer writes/modifies code and tests based on plan
      await implementer.generate([
        { role: 'system', content: IMPLEMENTER_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({
          plan,
          contextSnapshot: snapshot,
          previousTestResult: iteration > 0 ? testResult : undefined,
          iteration,
        })},
      ], { toolChoice: 'auto' });  // Agent uses MCP tools (writeFile, editFile, bash)

      // Run tests in the DinD sandbox
      const testOutput = await workspace.exec(plan.testStrategy.runCommand);
      testResult = parseTestOutput(testOutput, plan.testStrategy.framework);
      iteration++;
    }

    // 7. Collect diff and build CodeResult
    const diff = await workspace.exec('git', ['diff', repo.defaultBranch]);
    const headSha = await workspace.exec('git', ['rev-parse', 'HEAD']);

    return {
      branch: `auto/${snapshot.workRequest.externalTicketId}`,
      headSha: headSha.trim(),
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      testResults: testResult,
      implementationNotes: `Completed in ${iteration} TDD iterations`,
    };
  } finally {
    // 8. Tear down K8s Job (workspace is ephemeral)
    await k8sClient.deleteJob(workspace.jobId);
  }
}
```

### `runReviewNetwork` — Parallel Multi-Agent Review

Runs all reviewers concurrently via `Promise.allSettled`, then aggregates verdicts.

```typescript
// activities/runReviewNetwork.ts
export async function runReviewNetwork(
  codeResult: CodeResult,
  contextSnapshotId: string
): Promise<AggregatedReviewResult> {
  const snapshot = await prisma.contextSnapshot.findUniqueOrThrow({ where: { id: contextSnapshotId } });

  // Run all reviewers in parallel — each is an independent Mastra agent call
  const [securityVerdict, domainVerdict, perfVerdict] = await Promise.allSettled([
    runSecurityAuditor(codeResult),
    runDomainLogicReviewer(codeResult, snapshot),
    runPerformanceReviewer(codeResult),
  ]).then(results => results.map(r =>
    r.status === 'fulfilled' ? r.value : { reviewer: 'UNKNOWN', approved: false, severity: 'CRITICAL', findings: [{ file: '', category: 'REVIEWER_CRASH', description: (r as PromiseRejectedResult).reason.message, suggestedFix: 'Manual review required' }] } as ReviewVerdict
  ));

  const verdicts = [securityVerdict, domainVerdict, perfVerdict];
  const approved = verdicts.every(v => v.approved);

  return {
    approved,
    verdicts,
    codeResult,
    rejectionSummary: approved ? undefined : verdicts
      .filter(v => !v.approved)
      .flatMap(v => v.findings)
      .map(f => `[${f.category}] ${f.file}:${f.line ?? '?'} — ${f.suggestedFix}`)
      .join('\n'),
  };
}

// Each reviewer follows the same pattern: Mastra agent → structured output → ReviewVerdict
async function runSecurityAuditor(codeResult: CodeResult): Promise<ReviewVerdict> {
  const mastra = new Mastra({ /* config */ });
  const auditor = mastra.getAgent('security-auditor');
  const result = await auditor.generate([
    { role: 'system', content: SECURITY_AUDITOR_PROMPT },
    { role: 'user', content: JSON.stringify({ diff: codeResult.diff, filesChanged: codeResult.filesChanged }) },
  ], { output: ReviewVerdictSchema });  // Zod schema enforces structured output
  return result.object;
}
```

### `createOrUpdatePullRequest` — GitHub PR Management

```typescript
// activities/createOrUpdatePullRequest.ts
export async function createOrUpdatePullRequest(
  reviewResult: AggregatedReviewResult
): Promise<{ prNumber: number; prUrl: string }> {
  const { codeResult } = reviewResult;
  const repo = await getRepoForBranch(codeResult.branch);
  const token = await generateScopedInstallationToken(repo);
  const octokit = new Octokit({ auth: token });

  // Push the branch
  // (agent has already committed locally in the workspace)
  // The workspace exec pushes via the scoped token

  // Check if PR already exists for this branch
  const existing = await prisma.pullRequest.findFirst({
    where: { repository: { id: repo.id }, workflow: { assignedBranch: codeResult.branch }, status: 'OPEN' },
  });

  if (existing) {
    // Force-push updated branch; PR auto-updates
    await prisma.pullRequest.update({
      where: { id: existing.id },
      data: { headSha: codeResult.headSha, ciStatus: 'PENDING' },
    });
    return { prNumber: existing.prNumber!, prUrl: `https://github.com/${repo.organizationName}/${repo.repoName}/pull/${existing.prNumber}` };
  }

  // Create new PR
  const { data: pr } = await octokit.pulls.create({
    owner: repo.organizationName,
    repo: repo.repoName,
    title: `[Auto] ${codeResult.branch}`,
    body: formatPRBody(reviewResult),
    head: codeResult.branch,
    base: repo.defaultBranch,
  });

  await prisma.pullRequest.create({
    data: {
      prNumber: pr.number,
      headSha: codeResult.headSha,
      status: 'OPEN',
      ciStatus: 'PENDING',
      repository: { connect: { id: repo.id } },
      workflow: { connect: { id: (await getWorkflowForBranch(codeResult.branch)).id } },
    },
  });

  return { prNumber: pr.number, prUrl: pr.html_url };
}
```

### `fetchCILogs` + `executeCIFixImplementation` — CI Self-Healing

```typescript
// activities/ciFixLoop.ts
export async function fetchCILogs(logsUrl?: string): Promise<string> {
  if (!logsUrl) return 'No logs URL provided by CI webhook';
  const response = await fetch(logsUrl, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
  });
  const fullLog = await response.text();
  // Truncate to last 50KB to fit in LLM context
  return fullLog.slice(-50_000);
}

export async function executeCIFixImplementation(
  ciLogs: string,
  previousCodeResult: CodeResult
): Promise<CodeResult> {
  // Re-uses the same implementation activity but injects CI failure context
  // The agent sees: "Your previous code passed local tests but failed CI. Here are the logs."
  const mastra = new Mastra({ /* config */ });
  const implementer = mastra.getAgent('implementer');

  // Provision workspace, checkout the existing branch, apply fix
  const workspace = await provisionWorkspace(previousCodeResult.branch);
  try {
    await implementer.generate([
      { role: 'system', content: IMPLEMENTER_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({
        mode: 'CI_FIX',
        ciLogs,
        previousDiff: previousCodeResult.diff,
        previousTestResults: previousCodeResult.testResults,
      })},
    ], { toolChoice: 'auto' });

    // Re-run local tests after fix
    const testOutput = await workspace.exec('npm run test');
    const testResult = parseTestOutput(testOutput, 'jest');

    const diff = await workspace.exec('git', ['diff', 'origin/main']);
    const headSha = await workspace.exec('git', ['rev-parse', 'HEAD']);

    return {
      ...previousCodeResult,
      headSha: headSha.trim(),
      diff,
      filesChanged: parseDiffToFileChanges(diff),
      testResults: testResult,
      implementationNotes: `CI fix iteration. Logs analyzed: ${ciLogs.length} chars`,
    };
  } finally {
    await k8sClient.deleteJob(workspace.jobId);
  }
}
```

### `commitToMemory` — Workflow Summary to pgvector

```typescript
// activities/commitToMemory.ts
export async function commitToMemory(workflowId: string, repoId: string): Promise<void> {
  const workflow = await prisma.activeWorkflow.findUniqueOrThrow({
    where: { temporalWorkflowId: workflowId },
    include: { pullRequests: true, agentLessons: true },
  });

  // Memory Agent summarizes the full workflow lifecycle
  const mastra = new Mastra({ /* config */ });
  const memoryAgent = mastra.getAgent('memory-summarizer');
  const summary = await memoryAgent.generate([
    { role: 'system', content: 'Summarize this engineering workflow into a concise lesson learned. Focus on: what went wrong, what was fixed, and what should be avoided next time.' },
    { role: 'user', content: JSON.stringify(workflow) },
  ], { output: LessonSummarySchema });

  // Generate embedding and store
  const embedding = await generateEmbedding(summary.object.lessonSummary);
  await prisma.$executeRaw`
    INSERT INTO agent_lessons (id, workflow_id, repo_id, rationale, lesson_summary, embedding, failure_type, metadata, created_at)
    VALUES (gen_random_uuid(), ${workflow.id}::uuid, ${repoId}::uuid, ${summary.object.rationale},
            ${summary.object.lessonSummary}, ${embedding}::vector, ${summary.object.failureType}, ${summary.object.metadata}::jsonb, now())
  `;
}
```

### Utility Activities

```typescript
// activities/utilities.ts
export async function updateDomainState(workflowId: string, status: string, repoId: string): Promise<void> {
  await prisma.activeWorkflow.update({
    where: { temporalWorkflowId: workflowId },
    data: { currentStatus: status },
  });
}

export async function postSlackThreadAudit(workflowId: string, message: string): Promise<void> {
  const workflow = await prisma.activeWorkflow.findUniqueOrThrow({
    where: { temporalWorkflowId: workflowId },
    include: { workRequest: true },
  });
  if (workflow.workRequest?.slackMessageTs) {
    await slackClient.chat.postMessage({
      channel: workflow.workRequest.slackMessageTs,
      thread_ts: workflow.workRequest.slackMessageTs,
      text: message,
    });
  }
}

export async function notifyHumanGate(
  slackChannel: string | undefined,
  message: string,
  gateType: 'PR_READY' | 'PLAN_APPROVAL'
): Promise<void> {
  if (!slackChannel) return;
  await slackClient.chat.postMessage({
    channel: slackChannel,
    text: message,
    blocks: [{
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'View PR' }, action_id: `view_${gateType}` }],
    }],
  });
}
```
