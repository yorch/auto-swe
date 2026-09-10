import { prisma } from '@auto-swe/shared/db';
import { createKnowledgeBaseProvider } from '@auto-swe/shared/lib/integrations/registry';
import {
  resolveIssueTrackerConfig,
  resolveKnowledgeBaseConfig,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import { syncTrackerOnEvent } from '@auto-swe/shared/lib/trackerSync';
import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure, activityInfo } from '@temporalio/activity';
import { persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import { notifySlackPrReady } from '../lib/slackNotify.js';

export async function createOrUpdatePullRequest(
  request: RepoWorkRequest,
  codeResult: CodeResult
): Promise<{ prNumber: number; prUrl: string }> {
  const tracer = new AgentTracer();
  // Persist in a finally block so a failed GitHub call still leaves trace
  // rows for the run viewer — persisting only on the success paths silently
  // drops all records for failed attempts.
  try {
    return await doCreateOrUpdatePullRequest(request, codeResult, tracer);
  } finally {
    await persistActivityTrace(tracer, 'pr');
  }
}

async function doCreateOrUpdatePullRequest(
  request: RepoWorkRequest,
  codeResult: CodeResult,
  tracer: AgentTracer
): Promise<{ prNumber: number; prUrl: string }> {
  const repo = await prisma.connection.findUniqueOrThrow({
    include: { installation: { select: { installationId: true } } },
    where: { id: requireRepoId(request, 'createOrUpdatePullRequest') },
  });

  const workflowDefaults = await resolveWorkflowDefaults();
  const repoRef = toRepoRef(repo);
  const scm = getScmProvider(repoRef);

  // Check if PR already exists
  const existingPR = await prisma.pullRequest.findFirst({
    where: {
      repoId: repo.id,
      status: 'OPEN',
      workflow: { workRequestId: request.workRequestId },
    },
  });

  if (existingPR) {
    if (existingPR.prNumber == null) {
      throw ApplicationFailure.nonRetryable(
        `PR record ${existingPR.id} exists but has no prNumber — cannot build PR URL`,
        'PR_MISSING_NUMBER'
      );
    }

    // Re-arm the CI wait along with the head. This node always runs before the
    // workflow (re-)enters its CI wait, so `ciStatus = PENDING` means exactly
    // "no verdict has been delivered for the current head yet" — the freshness
    // token the `/webhooks/ci` handler guards its transition and its signal on.
    // Leaving a stale PASSED/FAILED here would let a verdict for the previous
    // head suppress the verdict for this one.
    await prisma.pullRequest.update({
      data: { ciStatus: 'PENDING', headSha: codeResult.headSha },
      where: { id: existingPR.id },
    });

    const prUrl = await scm.prUrl(repoRef, existingPR.prNumber);
    tracer.addActivityEvent({
      name: 'pr.updated',
      outputJson: {
        branch: codeResult.branch,
        headSha: codeResult.headSha,
        prNumber: existingPR.prNumber,
        prUrl,
      },
    });
    return { prNumber: existingPR.prNumber, prUrl };
  }

  // Create the PR (or, on Temporal retries, reuse one a prior attempt created
  // on the host but crashed before persisting the DB row — the tracking row is
  // still written below). Only a prior attempt could have orphaned a PR, so
  // the extra lookup round-trip is skipped on the first attempt.
  const { prNumber, prUrl } = await scm.createOrUpdatePullRequest({
    baseBranch: repo.defaultBranch,
    body: formatPRBody(request, codeResult, workflowDefaults.prBodyTemplate || undefined),
    headBranch: codeResult.branch,
    repo: repoRef,
    reuseExisting: activityInfo().attempt > 1,
    title: formatPRTitle(request, workflowDefaults.prTitleTemplate),
  });

  const workflow = await prisma.activeWorkflow.findFirst({
    where: { workRequestId: request.workRequestId },
  });

  await prisma.pullRequest.create({
    data: {
      ciStatus: 'PENDING',
      headSha: codeResult.headSha,
      prNumber,
      repoId: repo.id,
      status: 'OPEN',
      workflowId: workflow?.id,
    },
  });

  // Best-effort: let the originating Slack channel know the PR is open.
  await notifySlackPrReady({
    prNumber,
    prUrl,
    workRequestId: request.workRequestId,
  });

  // Best-effort tracker sync on PR opened.
  if (request.externalTicketId) {
    const trackerConfig = await resolveIssueTrackerConfig();
    await syncTrackerOnEvent(
      {
        issueId: request.externalTicketId,
        prTitle: `PR #${prNumber}`,
        prUrl,
        type: 'pr_opened',
      },
      trackerConfig
    ).catch(() => null);
  }

  // Best-effort Confluence PR link write-back — search for a page matching the
  // ticket ID and append the PR link. Never blocks the PR creation path.
  if (request.externalTicketId) {
    try {
      const kbConfig = await resolveKnowledgeBaseConfig();
      const kbProvider = createKnowledgeBaseProvider(kbConfig);
      if (kbProvider) {
        const pages = await kbProvider.searchPages(request.externalTicketId, kbConfig.spaces);
        if (pages.length > 0 && pages[0]) {
          await kbProvider.updatePageWithPrLink(pages[0].id, prUrl, `PR #${prNumber}`);
          tracer.addActivityEvent({
            name: 'kb.pr_link_updated',
            outputJson: { pageId: pages[0].id, pageTitle: pages[0].title, prUrl },
          });
        }
      }
    } catch {
      // KB write is best-effort — never fails the PR activity
    }
  }

  tracer.addActivityEvent({
    name: 'pr.created',
    outputJson: {
      branch: codeResult.branch,
      headSha: codeResult.headSha,
      prNumber,
      prUrl,
    },
  });

  return { prNumber, prUrl };
}

// ── Configurable PR Title & Body ──

const DEFAULT_PR_TITLE_TEMPLATE = '[auto-swe] {{ticketId}}';

const DEFAULT_PR_BODY_TEMPLATE = `## {{ticketId}}

**Description:** {{description}}
**Test Status:** {{testStatus}}
**Files Changed:** {{filesChanged}}

### Changes
{{fileList}}

### Agent Notes
{{notes}}

---
_Generated by auto-swe_`;

/**
 * Expand `{{key}}` placeholders in ONE pass. A sequential chain of
 * `.replace()` calls re-scanned the output of every earlier substitution, so
 * a `{{notes}}`/`{{fileList}}` token inside an agent-authored value (the
 * description, the implementation notes, a file path) was expanded on the
 * next pass. A single scan visits each placeholder in the template exactly
 * once and inserts values verbatim; unknown placeholders are left as-is, and
 * the function replacer keeps `$`-sequences in values literal.
 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? values[key] : match
  );
}

export function formatPRTitle(request: RepoWorkRequest, titleTemplate?: string): string {
  return renderTemplate(titleTemplate ?? DEFAULT_PR_TITLE_TEMPLATE, {
    description: request.description,
    ticketId: request.externalTicketId,
  });
}

export function formatPRBody(
  request: RepoWorkRequest,
  codeResult: CodeResult,
  bodyTemplate?: string
): string {
  const testStatus = codeResult.testResults.passed
    ? `All tests passing (${codeResult.testResults.passing}/${codeResult.testResults.total})`
    : `Tests failing (${codeResult.testResults.passing}/${codeResult.testResults.total} passing)`;

  const fileList = codeResult.filesChanged
    .map((f) => `- \`${f.path}\` (${f.operation}, +${f.linesAdded}/-${f.linesRemoved})`)
    .join('\n');

  return renderTemplate(bodyTemplate || DEFAULT_PR_BODY_TEMPLATE, {
    branch: codeResult.branch,
    description: request.description,
    fileList,
    filesChanged: String(codeResult.filesChanged.length),
    notes: codeResult.implementationNotes,
    testStatus,
    ticketId: request.externalTicketId,
  });
}
