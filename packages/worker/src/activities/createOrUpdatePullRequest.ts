import { prisma } from '@auto-swe/shared/db';
import { createKnowledgeBaseProvider } from '@auto-swe/shared/lib/integrations/registry';
import { clampPullRequestTitle } from '@auto-swe/shared/lib/pullRequest';
import {
  resolveIssueTrackerConfig,
  resolveKnowledgeBaseConfig,
  resolveWorkflowDefaults,
} from '@auto-swe/shared/lib/systemConfig';
import { syncTrackerOnEvent } from '@auto-swe/shared/lib/trackerSync';
import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure, activityInfo } from '@temporalio/activity';
import { currentWorkflowId, persistActivityTrace } from '../lib/activityContext.js';
import { AgentTracer } from '../lib/agentTracer.js';
import { requireRepoId } from '../lib/requireRepoId.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import {
  DraftPullRequestUnsupportedError,
  ExistingPullRequestNotDraftError,
} from '../lib/scm/types.js';
import { notifySlackPrReady } from '../lib/slackNotify.js';

export interface CreatePullRequestOptions {
  /** Open the PR as a draft; a host that cannot fails the step, never falls back. */
  draft?: boolean;
}

export async function createOrUpdatePullRequest(
  request: RepoWorkRequest,
  codeResult: CodeResult,
  options: CreatePullRequestOptions = {}
): Promise<{ prNumber: number; prUrl: string }> {
  const tracer = new AgentTracer();
  // Persist in a finally block so a failed GitHub call still leaves trace
  // rows for the run viewer — persisting only on the success paths silently
  // drops all records for failed attempts.
  try {
    return await doCreateOrUpdatePullRequest(request, codeResult, tracer, options);
  } finally {
    await persistActivityTrace(tracer, 'pr');
  }
}

async function doCreateOrUpdatePullRequest(
  request: RepoWorkRequest,
  codeResult: CodeResult,
  tracer: AgentTracer,
  options: CreatePullRequestOptions
): Promise<{ prNumber: number; prUrl: string }> {
  const repo = await prisma.connection.findUniqueOrThrow({
    include: { installation: { select: { host: true, installationId: true } } },
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

    // A draft was promised: never push agent commits onto a PR that has been marked
    // ready for review since. One API call, only on this path.
    if (options.draft && !(await scm.isDraftPullRequest(repoRef, existingPR.prNumber))) {
      throw notDraftFailure(`PR #${existingPR.prNumber}`, codeResult.branch);
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

  const title = formatPRTitle(request, workflowDefaults.prTitleTemplate);

  // A reviewer closed this workflow's PR without merging it. Repushing must not
  // quietly open a replacement: the close is a decision. A new run of the same
  // request has its own ledger row, so it is not stopped by this one.
  const latest = await prisma.pullRequest.findFirst({
    orderBy: { openedAt: 'desc' },
    select: { prNumber: true, status: true },
    where: {
      repoId: repo.id,
      workflow: { temporalWorkflowId: currentWorkflowId(), workRequestId: request.workRequestId },
    },
  });
  if (latest?.status === 'CLOSED') {
    throw ApplicationFailure.nonRetryable(
      `PR #${latest.prNumber} for ${codeResult.branch} was closed without merging, so no new pull ` +
        'request is opened for this run. Reopen it, or start a new run of the request.',
      'PR_CLOSED_BY_REVIEWER'
    );
  }

  // Create the PR (or, on Temporal retries, reuse one a prior attempt created
  // on the host but crashed before persisting the DB row — the tracking row is
  // still written below). Only a prior attempt could have orphaned a PR, so
  // the extra lookup round-trip is skipped on the first attempt.
  let created: { prNumber: number; prUrl: string };
  try {
    created = await scm.createOrUpdatePullRequest({
      baseBranch: repo.defaultBranch,
      body: formatPRBody(request, codeResult, workflowDefaults.prBodyTemplate || undefined),
      ...(options.draft ? { draft: true } : {}),
      headBranch: codeResult.branch,
      repo: repoRef,
      reuseExisting: activityInfo().attempt > 1,
      title,
    });
  } catch (err) {
    // "Draft" is a promise to the reviewer, so a repository that cannot hold
    // drafts fails the step rather than getting a ready-for-review PR. Retrying
    // cannot change the answer.
    if (err instanceof ExistingPullRequestNotDraftError) {
      throw notDraftFailure(err.message, codeResult.branch);
    }
    if (err instanceof DraftPullRequestUnsupportedError) {
      throw ApplicationFailure.nonRetryable(
        `${err.message}; the branch ${codeResult.branch} was pushed, but no pull request was opened`,
        'DRAFT_PR_UNSUPPORTED'
      );
    }
    throw err;
  }
  const { prNumber, prUrl } = created;

  // A work request can have several ledger rows (a scheduled fire's own row
  // beside the schedule's anchor, one per fire), so an unordered lookup could
  // link the PR to another execution and aim its CI webhook signals at it.
  // This execution's own row wins; the request-wide lookup is the fallback for
  // an execution that keeps no row of its own.
  const workflow =
    (await prisma.activeWorkflow.findFirst({
      where: { temporalWorkflowId: currentWorkflowId(), workRequestId: request.workRequestId },
    })) ??
    (await prisma.activeWorkflow.findFirst({
      where: { workRequestId: request.workRequestId },
    }));

  await prisma.pullRequest.create({
    data: {
      ciStatus: 'PENDING',
      headSha: codeResult.headSha,
      isDraft: options.draft === true,
      prNumber,
      repoId: repo.id,
      status: 'OPEN',
      title: clampPullRequestTitle(title),
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

function notDraftFailure(what: string, branch: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(
    `${what} is open and ready for review, and this step opens drafts only, so it will not add ` +
      `commits to it (branch ${branch}). Merge or close it and delete the branch, then run again.`,
    'EXISTING_PR_NOT_DRAFT'
  );
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
