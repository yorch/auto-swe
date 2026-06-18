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
    where: { id: request.repoId },
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

    await prisma.pullRequest.update({
      data: { headSha: codeResult.headSha },
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
        type: 'pr_opened',
        issueId: request.externalTicketId,
        prUrl,
        prTitle: `PR #${prNumber}`,
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
        const pages = await kbProvider.searchPages(
          request.externalTicketId,
          kbConfig.spaces,
        );
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

function formatPRTitle(request: RepoWorkRequest, titleTemplate?: string): string {
  const template = titleTemplate ?? DEFAULT_PR_TITLE_TEMPLATE;
  // Function replacers so `$`-sequences in the values (e.g. `$1`, `$&`) are
  // inserted literally rather than interpreted as replacement patterns.
  return template
    .replace(/\{\{ticketId\}\}/g, () => request.externalTicketId)
    .replace(/\{\{description\}\}/g, () => request.description);
}

function formatPRBody(
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

  const template = bodyTemplate || DEFAULT_PR_BODY_TEMPLATE;
  // Function replacers so `$`-sequences in agent-authored text (description,
  // notes, file paths) are inserted literally, not treated as `$1`/`$&` patterns.
  return template
    .replace(/\{\{ticketId\}\}/g, () => request.externalTicketId)
    .replace(/\{\{description\}\}/g, () => request.description)
    .replace(/\{\{branch\}\}/g, () => codeResult.branch)
    .replace(/\{\{testStatus\}\}/g, () => testStatus)
    .replace(/\{\{filesChanged\}\}/g, () => String(codeResult.filesChanged.length))
    .replace(/\{\{fileList\}\}/g, () => fileList)
    .replace(/\{\{notes\}\}/g, () => codeResult.implementationNotes);
}
