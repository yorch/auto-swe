/**
 * Evaluates one pull request at its current head: classifies its risk, publishes the commit
 * status and the reviewer brief, and (in `auto` mode only) asks GitHub to auto-merge a provably
 * low-risk change.
 *
 * Every decision is made by `@auto-swe/shared/lib/prEvaluation`, which is pure and fails closed;
 * this file only gathers its signals from the host and the database and carries out the result.
 * The one merge-capable call it makes is `enableAutoMerge`, which never merges immediately, and it
 * arms only when GitHub itself will hold the merge until our status is green
 * (`autoArmingRefusals`). It never overrides a person: it does not take a draft out of draft, and
 * it does not turn auto-merge back on after a person turned it off.
 *
 * Nothing here logs or stores a patch, a token or the policy file's text: logs carry counts,
 * names and statuses only.
 */

import type { Prisma } from '@auto-swe/shared';
import { invalidateSettingsCache, resolveSettings } from '@auto-swe/shared/config';
import { prisma } from '@auto-swe/shared/db';
import {
  type PlatformCredential,
  resolvePlatformCredential,
} from '@auto-swe/shared/lib/githubHostCredential';
import { repoHostFamily } from '@auto-swe/shared/lib/githubHostScope';
import { permissionMeets } from '@auto-swe/shared/lib/githubPermission';
import {
  type ApprovalState,
  approvalState,
  autoArmingRefusals,
  type BotApprovalCondition,
  type BotApprovalInput,
  BRIEF_MARKER,
  botApprovalRefusalConditions,
  buildBrief,
  type ChangedFile,
  type Classification,
  changedPathsAllowed,
  classify,
  type EvaluationSignals,
  type ExcludedIdentities,
  hasHumanObjection,
  hasNetTestDeletion,
  mergePolicy,
  type PolicyFloor,
  type PrEvaluationMode,
  parsePolicyFile,
  type Reason,
  type RepoPolicyFile,
  type ReviewSeverity,
  statusFor,
  truncateBrief,
} from '@auto-swe/shared/lib/prEvaluation';
import {
  autoEvidenceAssessment,
  type EvidenceThresholds,
  prEvaluationEvidence,
} from '@auto-swe/shared/lib/prEvaluationEvidence';
import { findPlatformPullRequest } from '@auto-swe/shared/lib/prEvaluationPlatformPr';
import type { PrEvaluationInput } from '@auto-swe/shared/lib/prEvaluationWorkflow';
import {
  resolveApproverBotSlugs,
  resolveGitHubApproverAppConfig,
  resolveGitHubConfig,
} from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';
import { logWarn } from '../lib/activityLog.js';
import { scanDiffForCodeIssuesDetailed } from '../lib/codeSecurityScanner.js';
import { resolveLauncherSet } from '../lib/prLauncher.js';
import {
  type ApproverClientResult,
  type ApproverSession,
  approverBotLogin,
  findOwnApproval,
  getApproverClient,
  submitApprovingReview,
} from '../lib/scm/approverApp.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';
import type {
  BranchRules,
  PullRequestDetails,
  PullRequestReviewSummary,
  RepoRef,
  ScmProvider,
} from '../lib/scm/types.js';

export const PR_POLICY_PATH = '.auto-swe/pr-policy.yml';

/** Changed patches beyond this many characters are not scanned, which fails the evaluation closed. */
const MAX_SCAN_CHARS = 2 * 1024 * 1024;
const MAX_PERSISTED_REASONS = 100;
const MAX_PERSISTED_PATHS = 100;
const MAX_PERSISTED_SKIM = 200;
const MAX_PERSISTED_CLAIMS = 50;
const MAX_TEXT = 500;

/** Stable reason codes recording what the platform did to GitHub's auto-merge, newest wins. */
const AUTO_ARMED = 'auto-armed';
const AUTO_DISARMED = 'auto-disarmed-by-platform';
const AUTO_SUPPRESSED = 'auto-suppressed-human';
const BOT_REASON_CODES: readonly string[] = [
  'bot-approval-credentials-missing',
  'bot-approval-posted',
  'bot-approval-present',
];
/**
 * One reason per review the platform dismissed, never filtered out of a row. `withdrawn` is for a
 * review of the head the row evaluated, and is what the human-dismissal count subtracts;
 * `withdrawn-older` is for a review of an earlier commit, which that count never looks at.
 */
const BOT_WITHDRAWN = 'bot-approval-withdrawn';
const BOT_WITHDRAWN_OLDER = 'bot-approval-withdrawn-older';
/** Recorded when a person dismissed the evaluator's approval; refuses every later head. */
const BOT_SUPPRESSED = 'bot-approval-suppressed';
const MARKER_CODES = [AUTO_ARMED, AUTO_DISARMED, AUTO_SUPPRESSED] as const;
type ArmMarker = (typeof MARKER_CODES)[number];
/** Rows read, newest first and a page at a time, when looking for the platform's newest marker. */
const MARKER_SCAN_ROWS = 500;
const MARKER_SCAN_PAGE = 100;

/** What the evaluator says on GitHub about its own approval: fixed text, never a name or an id. */
const botApprovalBody = (headSha: string): string =>
  `Approved by the auto-swe evaluator: LOW risk, all conditions met. This approval is bound to commit ${headSha.slice(0, 8)}.`;
const BOT_WITHDRAW_MESSAGE =
  'The auto-swe evaluator withdrew its approval: the conditions for approving no longer hold.';
const BOT_WITHDRAWN_STATUS = 'Evaluation is switched off: this status is no longer maintained';
/** Posted while an approval is withdrawn or an arming is cancelled, so no `success` stands beside them. */
const EVALUATION_CHANGED_STATUS = 'Evaluation changed: waiting';
/** Recorded whenever a reviewer's request for changes holds the evaluator back; survives a dismissal. */
const HUMAN_OBJECTION_SEEN = 'human-objection-seen';

export type EvaluatePullRequestResult = {
  outcome: 'skipped' | 'evaluated' | 'error' | 'superseded';
  riskClass?: 'LOW' | 'STANDARD' | 'HIGH';
  statusState?: 'pending' | 'success' | 'failure';
  autoMerge?: 'enabled' | 'disabled' | 'not-eligible' | 'unchanged';
  reason?: string;
};

/**
 * The approver App's side of bot approval: it submits an approval and names the bot's reviews.
 * It never withdraws one: that is the platform provider's `dismissReview`, which needs no approver
 * credential. Absent, the evaluation never submits or withdraws an approval (a deployment, or a
 * test, with no approver App).
 */
export type EvaluatorApproverDeps = {
  /** The approver App's configuration (its slug names the bot's reviews), or null when unset. */
  loadConfig: () => Promise<{ appSlug: string } | null>;
  /**
   * The slugs the approver's reviews are recognised by: the active App's, and those of Apps that
   * were removed or replaced (their approvals stand until dismissed). Absent, only the slug of
   * `loadConfig` is known.
   */
  loadBotSlugs?: () => Promise<{ active: string | null; retired: readonly string[] }>;
  getClient: (repo: RepoRef) => Promise<ApproverClientResult>;
  submit: typeof submitApprovingReview;
};

export type EvaluatePullRequestDeps = {
  /** See `EvaluatorApproverDeps`. */
  approver?: EvaluatorApproverDeps;
  scm: ScmProvider;
  /**
   * The id of the platform's own GitHub App for this repository's host, or null when its
   * credential is not an App. A requirement pinned to any other App is not ours.
   */
  expectedAppId: (repo: RepoRef) => Promise<number | null>;
  /**
   * The host family the repository lives on (`github.com`, `ghe.example.com`), which a linked
   * GitHub account's id is only comparable on.
   */
  repoHost: (repo: RepoRef) => Promise<string>;
  scan: (diff: string) => Promise<{ findings: readonly unknown[]; incomplete: boolean }>;
  now: () => Date;
};

const SETTING_KEYS = [
  'prEvaluation.botApprovalAllowed',
  'prEvaluation.botApprovalMaxFiles',
  'prEvaluation.botApprovalMaxLines',
  'prEvaluation.botApprovalPaths',
  'prEvaluation.enabled',
  'prEvaluation.defaultMode',
  'prEvaluation.autoMergeAllowed',
  'prEvaluation.autoMinEvidence',
  'prEvaluation.autoMinRepoEvidence',
  'prEvaluation.autoMinDistinctRequesters',
  'prEvaluation.autoEvidenceMinChangedLines',
  'prEvaluation.maxLowLines',
  'prEvaluation.maxLowFiles',
  'prEvaluation.maxLowDirs',
  'prEvaluation.highLines',
  'prEvaluation.lowApprovers',
  'prEvaluation.standardApprovers',
  'prEvaluation.highApprovers',
  'prEvaluation.sensitivePaths',
  'prEvaluation.requiredStatusContext',
] as const;

const SEVERITY_ORDER: Record<ReviewSeverity, number> = {
  CRITICAL: 3,
  INFO: 1,
  PASS: 0,
  WARNING: 2,
};

function isSeverity(value: unknown): value is ReviewSeverity {
  return typeof value === 'string' && Object.hasOwn(SEVERITY_ORDER, value);
}

/**
 * The highest severity the review network gave the head commit `headSha`, or null when it
 * cannot be shown that the network reviewed exactly that commit.
 *
 * The durable record is the `WorkflowStep` row of the run's `runReviewNetwork` step: its
 * `outputs` hold the aggregated verdicts together with the `codeResult` they reviewed, whose
 * `headSha` names the commit. The run is the one the pull request row links to. A later push (a
 * CI fix, PR-feedback round, or a person) moves the head, no step matches it, and the answer is
 * null: that commit has not been reviewed. Failed steps are read too, because a rejection that
 * only warned still carries its verdicts. A verdict without a known severity makes the whole
 * answer null.
 */
export async function loadMaxReviewSeverity(
  temporalWorkflowId: string,
  headSha: string
): Promise<ReviewSeverity | null> {
  const steps = await prisma.workflowStep.findMany({
    orderBy: { endedAt: 'desc' },
    select: { outputs: true },
    take: 20,
    where: {
      run: { workflowId: temporalWorkflowId },
      status: { in: ['PASSED', 'FAILED'] },
      stepName: 'runReviewNetwork',
    },
  });
  const wanted = headSha.toLowerCase();
  let max: ReviewSeverity | null = null;
  for (const step of steps) {
    const outputs = step.outputs as {
      codeResult?: { headSha?: unknown };
      verdicts?: unknown;
    } | null;
    const reviewed = outputs?.codeResult?.headSha;
    if (typeof reviewed !== 'string' || reviewed.toLowerCase() !== wanted) {
      continue;
    }
    if (!Array.isArray(outputs?.verdicts) || outputs.verdicts.length === 0) {
      return null;
    }
    for (const verdict of outputs.verdicts as { severity?: unknown }[]) {
      if (!isSeverity(verdict?.severity)) {
        return null;
      }
      if (max === null || SEVERITY_ORDER[verdict.severity] > SEVERITY_ORDER[max]) {
        max = verdict.severity;
      }
    }
  }
  return max;
}

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** An error Temporal should retry the activity for: the host or the database is unreachable or busy. */
export function isRetryableEvaluationError(err: unknown): boolean {
  if (err instanceof ApplicationFailure) {
    return !err.nonRetryable;
  }
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const { status, code, message } = err as { status?: unknown; code?: unknown; message?: unknown };
  if (typeof status === 'number') {
    if (status >= 500 || status === 429 || status === 408) {
      return true;
    }
    return status === 403 && typeof message === 'string' && /rate limit|abuse/i.test(message);
  }
  if (typeof code === 'string') {
    // Prisma: P1001 cannot reach the database, P1002 timed out, P1008 operation timed out,
    // P1017 server closed the connection.
    return RETRYABLE_CODES.has(code) || /^P10(01|02|08|17)$/.test(code);
  }
  return false;
}

/** What may be logged or stored about an error: its class and host status, never its text. */
function safeErrorMeta(err: unknown): { errorName: string; status?: number } {
  const name = err instanceof Error ? err.name : typeof err;
  const status = (err as { status?: unknown } | null)?.status;
  return { errorName: name, ...(typeof status === 'number' ? { status } : {}) };
}

function clip(text: string, max = MAX_TEXT): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

/**
 * Reasons that later evaluations read to decide, so losing one fails open (a request for changes
 * forgotten, a suppression forgotten). They are each bounded at the source (one per row, a
 * `withdrawn` entry per dismissal made in one evaluation), so they are exempt from the cap and only
 * the ordinary reasons are cut.
 */
const SAFETY_MARKER_CODES: ReadonlySet<string> = new Set([
  HUMAN_OBJECTION_SEEN,
  BOT_SUPPRESSED,
  BOT_WITHDRAWN,
  BOT_WITHDRAWN_OLDER,
  ...MARKER_CODES,
]);

export function boundReasons(reasons: readonly Reason[]): Reason[] {
  const markers = reasons.filter((r) => SAFETY_MARKER_CODES.has(r.code)).length;
  let room = Math.max(0, MAX_PERSISTED_REASONS - markers);
  const kept = reasons.filter((r) => {
    if (SAFETY_MARKER_CODES.has(r.code)) {
      return true;
    }
    if (room > 0) {
      room -= 1;
      return true;
    }
    return false;
  });
  return kept.map((reason) => ({
    code: reason.code,
    message: clip(reason.message),
    severity: reason.severity,
    ...(reason.paths ? { paths: reason.paths.slice(0, MAX_PERSISTED_PATHS) } : {}),
  }));
}

function infoReason(code: string, message: string): Reason {
  return { code, message, severity: 'info' };
}

const EMPTY_BRIEF = { claimsToVerify: [], focus: [], markdown: '', skim: [] };

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

/** The synthetic diff the code-security scanner reads: added lines only matter to it. */
function diffOf(files: readonly ChangedFile[]): { diff: string; unscannable: boolean } {
  let size = 0;
  let unscannable = false;
  const parts: string[] = [];
  for (const file of files) {
    if (file.patch === undefined) {
      // A text file whose patch the host omitted (too large) cannot be scanned.
      if (file.additions + file.deletions > 0) {
        unscannable = true;
      }
      continue;
    }
    size += file.patch.length;
    if (size > MAX_SCAN_CHARS) {
      return { diff: '', unscannable: true };
    }
    parts.push(`--- a/${file.previousPath ?? file.path}\n+++ b/${file.path}\n${file.patch}`);
  }
  return { diff: parts.join('\n'), unscannable };
}

type AutoDecision = { eligible: boolean; blockers: string[] };

type ArmedRow = { headSha: string; id: string; reasons: unknown } | null;

/**
 * The App id the platform's credential for `repo`'s host authenticates as; null for a personal
 * access token, an App with no numeric id, or a host with no usable credential. The set comes
 * from `resolvePlatformCredential` (never the instance's config directly), and the PAT-or-App
 * choice mirrors `resolveGitHubToken`, so the id is the one the status is actually posted by.
 */
export async function expectedAppIdFor(
  repo: RepoRef,
  via: {
    loadConfig: () => Promise<Awaited<ReturnType<typeof resolveGitHubConfig>>>;
    credential: (
      repo: RepoRef,
      config: Awaited<ReturnType<typeof resolveGitHubConfig>>
    ) => Promise<PlatformCredential>;
  } = {
    credential: (target, config) =>
      resolvePlatformCredential(
        {
          apiUrl: target.apiUrl,
          baseUrl: target.baseUrl,
          installationHost: target.installationHost,
          installationId: target.installationId,
        },
        config
      ),
    loadConfig: resolveGitHubConfig,
  }
): Promise<number | null> {
  const credential = await via.credential(repo, await via.loadConfig());
  if (credential.scope !== 'instance' && credential.scope !== 'host') {
    return null;
  }
  const { config } = credential;
  const mode = config.authMode ?? 'auto';
  const installationId = repo.installationId ?? config.appInstallationId;
  const appConfigured =
    Boolean(config.appId) && Boolean(config.appPrivateKey) && Boolean(installationId);
  if (!(mode === 'app' || (mode === 'auto' && appConfigured))) {
    return null;
  }
  const id = /^\d+$/.test(config.appId ?? '') ? Number(config.appId) : Number.NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function evaluatePullRequest(
  input: PrEvaluationInput
): Promise<EvaluatePullRequestResult> {
  return evaluatePullRequestWith(input, {
    approver: {
      getClient: getApproverClient,
      loadBotSlugs: resolveApproverBotSlugs,
      loadConfig: resolveGitHubApproverAppConfig,
      submit: submitApprovingReview,
    },
    expectedAppId: (repo) => expectedAppIdFor(repo),
    now: () => new Date(),
    repoHost: async (repo) =>
      repoHostFamily({ apiUrl: repo.apiUrl, baseUrl: repo.baseUrl }, await resolveGitHubConfig()),
    scan: scanDiffForCodeIssuesDetailed,
    scm: getScmProvider(),
  });
}

function reasonCodes(reasons: unknown): string[] {
  return Array.isArray(reasons)
    ? reasons.flatMap((r) =>
        typeof r === 'object' && r !== null && typeof (r as { code?: unknown }).code === 'string'
          ? [(r as { code: string }).code]
          : []
      )
    : [];
}

/**
 * The platform's newest record of what it did to this pull request's auto-merge, from the
 * reasons of its evaluation rows. Null when it never armed, disarmed or suppressed.
 */
async function latestMarker(
  connectionId: string,
  prNumber: number,
  hasArmedRow: boolean
): Promise<ArmMarker | null> {
  let scanned = 0;
  while (scanned < MARKER_SCAN_ROWS) {
    const rows = await prisma.prEvaluation.findMany({
      orderBy: { createdAt: 'desc' },
      select: { reasons: true },
      skip: scanned,
      take: Math.min(MARKER_SCAN_PAGE, MARKER_SCAN_ROWS - scanned),
      where: { connectionId, prNumber },
    });
    for (const row of rows) {
      const codes = reasonCodes(row.reasons);
      const found = MARKER_CODES.find((code) => codes.includes(code));
      if (found) {
        return found;
      }
    }
    scanned += rows.length;
    if (rows.length < MARKER_SCAN_PAGE) {
      return null;
    }
  }
  // The cap was reached without a marker. A pull request the platform armed once, whose marker is
  // out of reach, may have been turned off by a person: fail safe and do not arm it again.
  return hasArmedRow ? AUTO_SUPPRESSED : null;
}

/** The newest evaluation row that recorded an arming, or null. A cheap database check. */
async function latestArmedRow(connectionId: string, prNumber: number): Promise<ArmedRow> {
  return prisma.prEvaluation.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { headSha: true, id: true, reasons: true },
    where: { autoMergeEnabled: true, connectionId, prNumber },
  });
}

function retryableDisarmFailure(): ApplicationFailure {
  return ApplicationFailure.retryable(
    'auto-merge could not be disabled',
    'AUTO_MERGE_DISABLE_FAILED'
  );
}

/**
 * Turns GitHub's auto-merge off and proves it. A refusal is not trusted either way: the pull
 * request is read again, and only a host that now shows auto-merge off counts as done. Anything
 * else throws a retryable failure, so the activity is retried instead of leaving an arming behind.
 */
async function disarm(scm: ScmProvider, repo: RepoRef, prNumber: number): Promise<void> {
  try {
    const result = await scm.disableAutoMerge(repo, prNumber);
    if (result.ok) {
      return;
    }
    logWarn('pr evaluation: auto-merge could not be disabled', {
      prNumber,
      reason: clip(result.reason ?? 'refused', 200),
    });
  } catch (err) {
    if (isRetryableEvaluationError(err)) {
      throw err;
    }
    logWarn('pr evaluation: auto-merge could not be disabled', {
      prNumber,
      ...safeErrorMeta(err),
    });
  }
  let current: PullRequestDetails | null;
  try {
    current = await scm.getPullRequest(repo, prNumber);
  } catch (err) {
    if (isRetryableEvaluationError(err)) {
      throw err;
    }
    throw retryableDisarmFailure();
  }
  if (current && current.state === 'open' && current.autoMerge.enabled) {
    throw retryableDisarmFailure();
  }
}

/** Records, on the row that carries the evidence, that the platform turned auto-merge off. */
async function recordDisarmed(
  connectionId: string,
  prNumber: number,
  target: { id: string; reasons: unknown } | null
): Promise<void> {
  try {
    if (target) {
      const kept = (Array.isArray(target.reasons) ? target.reasons : []).filter(
        (r) => !MARKER_CODES.some((c) => c === (r as { code?: unknown } | null)?.code)
      ) as Reason[];
      await prisma.prEvaluation.update({
        data: {
          autoMergeEnabled: false,
          reasons: asJson(
            boundReasons([
              ...kept,
              infoReason(
                AUTO_DISARMED,
                'The platform turned auto-merge off for this pull request.'
              ),
            ])
          ),
        },
        where: { id: target.id },
      });
    }
    await prisma.prEvaluation.updateMany({
      data: { autoMergeEnabled: false },
      where: { autoMergeEnabled: true, connectionId, prNumber },
    });
  } catch (err) {
    // Missing this marker errs towards suppressing a later arming, never towards arming.
    logWarn('pr evaluation: the disarming could not be recorded', safeErrorMeta(err));
  }
}

/** The newest evaluation row that recorded a standing bot approval, or null. A cheap database check. */
/**
 * The logins the approver's reviews are recognised by: the active App's (`active`, the only one
 * that may approve) and every retired App's. `all` is empty when no slug is known at all.
 */
async function approverLogins(
  approver: EvaluatorApproverDeps,
  config: { appSlug: string } | null
): Promise<{ active: string | null; all: string[] }> {
  const slugs = approver.loadBotSlugs
    ? await approver.loadBotSlugs()
    : { active: config?.appSlug ?? null, retired: [] };
  const active = slugs.active ? approverBotLogin({ appSlug: slugs.active }) : null;
  const retired = slugs.retired
    .filter((slug) => slug.trim() !== '')
    .map((slug) => approverBotLogin({ appSlug: slug }));
  return { active, all: [...new Set([...(active ? [active] : []), ...retired])] };
}

/**
 * The approver App's configuration, or null when it cannot be read (a key that does not decrypt, a
 * database error). The bot's logins then come from the slugs, which need no key. Only the error's
 * name is logged.
 */
async function loadApproverConfig(
  approver: EvaluatorApproverDeps
): Promise<{ appSlug: string } | null> {
  try {
    return await approver.loadConfig();
  } catch (err) {
    logWarn('pr evaluation: the approver App configuration could not be read', safeErrorMeta(err));
    return null;
  }
}

/** The same, for the logins: no slug is known when they cannot be read, so nothing is recognised. */
async function loadApproverLogins(
  approver: EvaluatorApproverDeps,
  config: { appSlug: string } | null
): Promise<{ active: string | null; all: string[] }> {
  try {
    return await approverLogins(approver, config);
  } catch (err) {
    logWarn('pr evaluation: the approver App slugs could not be read', safeErrorMeta(err));
    return { active: null, all: [] };
  }
}

/** Every APPROVED review whose author is one of `logins` (lower-case), in the host's order. */
function approvalsOf<T extends { login: string; state: string }>(
  reviews: readonly T[],
  logins: readonly string[]
): T[] {
  return reviews.filter((r) => r.state === 'APPROVED' && logins.includes(r.login.toLowerCase()));
}

async function latestBotRow(
  connectionId: string,
  prNumber: number
): Promise<{ botApproved: boolean; headSha: string; id: string; reasons: unknown } | null> {
  return prisma.prEvaluation.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { botApproved: true, headSha: true, id: true, reasons: true },
    where: { botApproved: true, connectionId, prNumber },
  });
}

const NOT_WITHDRAWN_REASONS: readonly string[] = [
  'refused',
  'not-found',
  'unprocessable',
  'invalid-input',
];

function botNotWithdrawn(): ApplicationFailure {
  return ApplicationFailure.retryable(
    'a bot approval could not be withdrawn',
    'BOT_APPROVAL_NOT_WITHDRAWN'
  );
}

function botStatusNotPosted(): ApplicationFailure {
  return ApplicationFailure.retryable(
    'the status behind a bot approval could not be posted',
    'BOT_APPROVAL_STATUS_NOT_POSTED'
  );
}

/**
 * Dismisses every one of the approver's standing approvals, whatever commit it names, through the
 * PLATFORM credential: dismissing needs write access only, so deleting or rotating the approver's
 * credentials never strands an approval. True only when every one is gone. Logs fixed reasons and
 * error names, never a login or an id; an error Temporal should retry is rethrown.
 */
async function dismissAll(args: {
  approvals: readonly PullRequestReviewSummary[];
  connectionId: string;
  prNumber: number;
  repo: RepoRef;
  scm: ScmProvider;
}): Promise<{ dismissed: PullRequestReviewSummary[]; gone: boolean }> {
  const meta = { connectionId: args.connectionId, prNumber: args.prNumber };
  let allGone = true;
  const dismissed: PullRequestReviewSummary[] = [];
  for (const review of args.approvals) {
    if (!review.id) {
      logWarn('pr evaluation: bot approval cannot be withdrawn', {
        ...meta,
        reason: 'no-review-id',
      });
      allGone = false;
      continue;
    }
    try {
      const out = await args.scm.dismissReview(
        args.repo,
        args.prNumber,
        review.id,
        BOT_WITHDRAW_MESSAGE
      );
      if (!out.ok) {
        const reason =
          out.reason !== undefined && NOT_WITHDRAWN_REASONS.includes(out.reason)
            ? out.reason
            : 'refused';
        logWarn('pr evaluation: bot approval was not withdrawn', {
          ...meta,
          reason: `dismiss-${reason}`,
        });
        allGone = false;
      } else {
        dismissed.push(review);
      }
    } catch (err) {
      if (isRetryableEvaluationError(err)) {
        throw err;
      }
      logWarn('pr evaluation: bot approval could not be withdrawn', {
        ...meta,
        ...safeErrorMeta(err),
      });
      allGone = false;
    }
  }
  return { dismissed, gone: allGone };
}

/** One reason per dismissed review, by whether it was a review of the head that was evaluated. */
function withdrawnReasons(
  dismissed: readonly PullRequestReviewSummary[],
  headSha: string
): Reason[] {
  return dismissed.map((review) =>
    review.commitId === headSha
      ? infoReason(BOT_WITHDRAWN, 'The evaluator withdrew its approval.')
      : infoReason(BOT_WITHDRAWN_OLDER, 'The evaluator withdrew an approval of an earlier commit.')
  );
}

/** A review by someone other than the author and a bot that a person dismissed. */
function isDismissedHumanReview(review: PullRequestReviewSummary, author: string): boolean {
  const login = review.login.toLowerCase();
  return review.state === 'DISMISSED' && login !== author.toLowerCase() && !login.endsWith('[bot]');
}

/** What the evaluation rows of one pull request say, read in one pass. */
type PrHistory = {
  /** A row recorded that a person dismissed the evaluator's approval. */
  suppressed: boolean;
  /** `bot-approval-withdrawn` reasons on rows of the evaluated head, one per dismissal made. */
  withdrawn: number;
  /**
   * Whether a row recorded a request for changes. `unknown` when the scan reached its cap without
   * seeing one: the caller weighs that against what the review list shows.
   */
  objection: 'seen' | 'none' | 'unknown';
};

/**
 * Reads the evaluation rows newest first, a page at a time and up to `MARKER_SCAN_ROWS`, once:
 * a row that records the suppression settles it; the `bot-approval-withdrawn` reasons on rows of
 * this head are counted, one per dismissal the platform made, so a dismissal of the evaluator's
 * approval beyond that count was someone else's (the person-dismissal rule); and a
 * `human-objection-seen` reason on any row says a reviewer once asked for changes. A review of an
 * earlier commit is not counted: the host dismisses those itself on a push. The rows read are a
 * lower bound on the dismissals the platform made, so a scan that cannot see them all errs
 * towards suppressed.
 */
async function readPrHistory(
  connectionId: string,
  prNumber: number,
  headSha: string
): Promise<PrHistory> {
  const history: PrHistory = { objection: 'none', suppressed: false, withdrawn: 0 };
  let scanned = 0;
  while (scanned < MARKER_SCAN_ROWS) {
    const rows = await prisma.prEvaluation.findMany({
      orderBy: { createdAt: 'desc' },
      select: { headSha: true, reasons: true },
      skip: scanned,
      take: Math.min(MARKER_SCAN_PAGE, MARKER_SCAN_ROWS - scanned),
      where: { connectionId, prNumber },
    });
    for (const row of rows) {
      const codes = reasonCodes(row.reasons);
      if (codes.includes(BOT_SUPPRESSED)) {
        return { ...history, suppressed: true };
      }
      if (codes.includes(HUMAN_OBJECTION_SEEN)) {
        history.objection = 'seen';
      }
      if (row.headSha === headSha) {
        history.withdrawn += codes.filter((c) => c === BOT_WITHDRAWN).length;
      }
    }
    scanned += rows.length;
    if (rows.length < MARKER_SCAN_PAGE) {
      return history;
    }
  }
  return history.objection === 'seen' ? history : { ...history, objection: 'unknown' };
}

/** Sets the status back to `pending`; true when the host accepted it. Never throws for a refusal. */
async function postPending(
  scm: ScmProvider,
  repo: RepoRef,
  headSha: string,
  context: string,
  description: string
): Promise<boolean> {
  try {
    return (
      await scm.setCommitStatus(repo, headSha, {
        context,
        description,
        state: 'pending',
      })
    ).ok;
  } catch (err) {
    if (isRetryableEvaluationError(err)) {
      throw err;
    }
    return false;
  }
}

/**
 * Evaluation is off for this pull request (the feature, or this repository). A pull request the
 * platform armed earlier must not stay armed, and one the approver App approved must not keep a
 * `success` status the approval alone earned, nor the approval itself. Armed rows and bot rows are
 * acted on from GitHub's real state. With an approver App configured, the review list is checked
 * for ANY approval of its own on every skip, row or no row: a crash between a submit and its row,
 * an unconfirmed submit or a switch turned off earlier all leave one that no row records.
 */
async function skipAndDisarm(
  connection: { id: string; teamId?: string | null; team?: { orgId: string | null } | null },
  input: PrEvaluationInput,
  deps: EvaluatePullRequestDeps,
  repo: RepoRef,
  reason: string
): Promise<EvaluatePullRequestResult> {
  const skipped: EvaluatePullRequestResult = { outcome: 'skipped', reason };
  const armedRow = await latestArmedRow(connection.id, input.prNumber);
  const foundBot = await latestBotRow(connection.id, input.prNumber);
  const botRow = foundBot?.botApproved === true ? foundBot : null;
  const approverConfig = deps.approver ? await loadApproverConfig(deps.approver) : null;
  const logins = deps.approver
    ? await loadApproverLogins(deps.approver, approverConfig)
    : { active: null, all: [] };
  if (!armedRow && !botRow && !approverConfig && logins.all.length === 0) {
    return skipped;
  }
  const { scm } = deps;
  let pr: PullRequestDetails | null;
  try {
    pr = await scm.getPullRequest(repo, input.prNumber);
  } catch (err) {
    if (isRetryableEvaluationError(err)) {
      throw err;
    }
    throw retryableDisarmFailure();
  }
  // The status goes back and the approvals are dismissed BEFORE the arming is cancelled: a disarm
  // that cannot be proven throws, and the pending status is what then still holds the merge.
  await withdrawWhenOff(connection, input, deps, repo, pr, botRow, approverConfig, logins.all);
  let result = skipped;
  if (armedRow && pr && pr.state === 'open' && pr.autoMerge.enabled) {
    await disarm(scm, repo, input.prNumber);
    await recordDisarmed(connection.id, input.prNumber, armedRow);
    result = { ...skipped, autoMerge: 'disabled' };
  }
  return result;
}

/**
 * Switched off: whatever the approver App approved comes back. The status goes to `pending` FIRST
 * (a `success` the bot earned must not outlive the switch, and a stale approval alone cannot merge
 * without it), then every standing approval of the App is dismissed through the platform
 * credential. A status that cannot be posted, or an approval that cannot be dismissed, throws a
 * retryable failure and leaves the flag set, so a later attempt tries again. The reviews of the
 * active App and of every retired one are recognised, so deleting or replacing the App strands no
 * approval; with no slug known at all the bot's reviews cannot be told apart from anyone's, so
 * nothing is dismissed. A row says when the App's credentials are missing.
 */
async function withdrawWhenOff(
  connection: { id: string; teamId?: string | null; team?: { orgId: string | null } | null },
  input: PrEvaluationInput,
  deps: EvaluatePullRequestDeps,
  repo: RepoRef,
  pr: PullRequestDetails | null,
  botRow: { headSha: string; id: string; reasons: unknown } | null,
  config: { appSlug: string } | null,
  logins: readonly string[]
): Promise<void> {
  const clear = (): Promise<unknown> =>
    prisma.prEvaluation.updateMany({
      data: { botApproved: false },
      where: { botApproved: true, connectionId: connection.id, prNumber: input.prNumber },
    });
  if (!pr || pr.merged || pr.state !== 'open') {
    if (botRow) {
      await clear();
    }
    return;
  }
  let standing: PullRequestReviewSummary[] = [];
  if (logins.length > 0) {
    try {
      standing = approvalsOf(await deps.scm.listPullRequestReviews(repo, input.prNumber), logins);
    } catch (err) {
      if (isRetryableEvaluationError(err)) {
        throw err;
      }
      logWarn('pr evaluation: the reviews could not be read', safeErrorMeta(err));
      throw botNotWithdrawn();
    }
  }
  const headRecorded = botRow !== null && botRow.headSha === pr.headSha;
  if (standing.length === 0 && !headRecorded) {
    // An approval of an older head with nothing standing: no status of this head is the bot's.
    if (botRow) {
      await clear();
    }
    return;
  }
  const settings = await resolveSettings(['prEvaluation.requiredStatusContext'], {
    ...(connection.team?.orgId ? { orgId: connection.team.orgId } : {}),
    teamId: connection.teamId ?? undefined,
  });
  if (
    !(await postPending(
      deps.scm,
      repo,
      pr.headSha,
      settings['prEvaluation.requiredStatusContext'],
      BOT_WITHDRAWN_STATUS
    ))
  ) {
    throw ApplicationFailure.retryable(
      'the status behind a bot approval could not be withdrawn',
      'BOT_APPROVAL_STATUS_NOT_WITHDRAWN'
    );
  }
  const dismissal =
    standing.length > 0
      ? await dismissAll({
          approvals: standing,
          connectionId: connection.id,
          prNumber: input.prNumber,
          repo,
          scm: deps.scm,
        })
      : { dismissed: [], gone: true };
  if (!dismissal.gone) {
    throw botNotWithdrawn();
  }
  // One reason per dismissal, on a row of this head: it is how a later evaluation tells the
  // platform's dismissals from a person's.
  const withdrawn = withdrawnReasons(dismissal.dismissed, pr.headSha);
  try {
    let recorded = false;
    if (botRow) {
      const kept = (Array.isArray(botRow.reasons) ? botRow.reasons : []).filter(
        (r) => !BOT_REASON_CODES.includes((r as { code?: unknown } | null)?.code as string)
      ) as Reason[];
      const onThisHead = botRow.headSha === pr.headSha;
      await prisma.prEvaluation.update({
        data: {
          reasons: asJson(
            boundReasons([
              ...kept,
              ...(onThisHead ? withdrawn : []),
              ...(config
                ? []
                : [
                    infoReason(
                      'bot-approval-credentials-missing',
                      'The approver GitHub App is not configured, so an approval it gave cannot be recognised or withdrawn.'
                    ),
                  ]),
            ])
          ),
        },
        where: { id: botRow.id },
      });
      recorded = onThisHead;
    }
    if (!recorded && withdrawn.length > 0) {
      const target = await prisma.prEvaluation.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { id: true, reasons: true },
        where: { connectionId: connection.id, headSha: pr.headSha, prNumber: input.prNumber },
      });
      if (target) {
        await prisma.prEvaluation.update({
          data: {
            reasons: asJson(
              boundReasons([
                ...(Array.isArray(target.reasons) ? (target.reasons as Reason[]) : []),
                ...withdrawn,
              ])
            ),
          },
          where: { id: target.id },
        });
      } else {
        logWarn('pr evaluation: the bot approval withdrawal has no row to be recorded on', {
          connectionId: connection.id,
          prNumber: input.prNumber,
        });
      }
    }
    if (botRow) {
      await clear();
    }
  } catch (err) {
    if (isRetryableEvaluationError(err)) {
      throw err;
    }
    // Bookkeeping only: the status went back to pending and the approvals are gone.
    logWarn('pr evaluation: the bot approval withdrawal could not be recorded', safeErrorMeta(err));
  }
}

/** Started by the merge webhook, after it stamped `mergedAt` on the row of the merged head. */
const MERGED_TRIGGER = 'merged';

/**
 * The merge-time recount. The approval fact on an evaluation row was taken when the head was
 * evaluated; the row is stamped merged later. A dismissed approval followed by an admin
 * bypass-merge starts no evaluation (the pull request is merged), so the row would keep the
 * earlier, higher count. This recounts at the merged head with the same trust filter and
 * launcher exclusion as an evaluation and writes the result to the one stamped row.
 *
 * It only ever lowers or confirms: any failure writes 0. It publishes no status, posts no
 * comment, arms and disarms nothing, never throws for a missing row, and logs no ids.
 */
async function recountMergedApprovals(
  connection: { id: string },
  input: PrEvaluationInput,
  deps: EvaluatePullRequestDeps,
  repo: RepoRef
): Promise<EvaluatePullRequestResult> {
  const skipped: EvaluatePullRequestResult = {
    outcome: 'skipped',
    reason: 'merged: approvals recounted',
  };
  const row = await prisma.prEvaluation.findFirst({
    orderBy: { mergedAt: 'desc' },
    select: { headSha: true, id: true },
    where: { connectionId: connection.id, mergedAt: { not: null }, prNumber: input.prNumber },
  });
  if (!row) {
    logWarn('pr evaluation: no merged evaluation row to recount', {});
    return skipped;
  }
  let recounted = 0;
  try {
    const platformPr = await findPlatformPullRequest(prisma, connection.id, input.prNumber);
    if (!platformPr?.workflow) {
      throw new Error('not a pull request the platform opened');
    }
    const launcher = await resolveLauncherSet(prisma, {
      repoHost: await deps.repoHost(repo),
      repoId: connection.id,
      runId: platformPr.runId,
      temporalWorkflowId: platformPr.workflow.temporalWorkflowId,
      workRequestId: platformPr.workflow.workRequestId,
    });
    const pr = await deps.scm.getPullRequest(repo, input.prNumber);
    if (!pr?.merged) {
      throw new Error('the pull request is not merged');
    }
    const reviews = await deps.scm.listPullRequestReviews(repo, input.prNumber);
    const trusted = await trustedApprovers(
      deps.scm,
      repo,
      reviews,
      pr.author ?? '',
      1,
      row.headSha,
      launcher
    );
    recounted = launcher.resolved ? trusted.approval.approvers.length : 0;
  } catch (err) {
    // Fail closed: nothing could be shown, so the row keeps no approval.
    logWarn('pr evaluation: the merged approvals could not be recounted', safeErrorMeta(err));
    recounted = 0;
  }
  try {
    await prisma.prEvaluation.update({
      data: { trustedApprovers: recounted },
      where: { id: row.id },
    });
  } catch (err) {
    if (isRetryableEvaluationError(err)) {
      throw err;
    }
    logWarn('pr evaluation: the recounted approvals could not be recorded', safeErrorMeta(err));
  }
  return skipped;
}

/** The evaluation's status as the host accepted it: never carries the host's own text. */
type StatusPublished = { ok: boolean; reason?: 'refused' | 'error' };

/** The activity body with its collaborators passed in, so a test can supply fakes. */
export async function evaluatePullRequestWith(
  input: PrEvaluationInput,
  deps: EvaluatePullRequestDeps
): Promise<EvaluatePullRequestResult> {
  const connection = await prisma.connection.findFirst({
    include: {
      installation: { select: { host: true, installationId: true } },
      team: { select: { orgId: true } },
    },
    where: { id: input.connectionId, type: 'git_repo' },
  });
  if (!connection) {
    return { outcome: 'skipped', reason: 'repository not found or inactive' };
  }
  const repo = toRepoRef(connection);
  if (input.trigger === MERGED_TRIGGER) {
    return recountMergedApprovals(connection, input, deps, repo);
  }
  if (!connection.isActive) {
    // A deactivated repository is treated as `off`: an arming it still carries is cancelled.
    return skipAndDisarm(connection, input, deps, repo, 'repository is inactive');
  }
  if (input.trigger === 'disarm-sweep') {
    // The gateway started this sweep right after a GLOBAL write of a kill switch; this process's
    // settings cache (per process, ~30 s) may still hold the old value, which would re-arm.
    invalidateSettingsCache();
  }
  // The fullest scope the connection has: a lookup without its team silently resolves a
  // broader value.
  const settings = await resolveSettings(SETTING_KEYS, {
    ...(connection.team?.orgId ? { orgId: connection.team.orgId } : {}),
    teamId: connection.teamId ?? undefined,
  });
  if (!settings['prEvaluation.enabled']) {
    return skipAndDisarm(connection, input, deps, repo, 'pull request evaluation is switched off');
  }
  const chosen = (connection.prEvaluationMode ??
    settings['prEvaluation.defaultMode']) as PrEvaluationMode;
  if (chosen === 'off') {
    return skipAndDisarm(connection, input, deps, repo, 'evaluation is off for this repository');
  }
  // What the status says follows the chosen mode. Whether auto-merge may be armed is a separate
  // question: a deployment that forbids it still holds an `auto` repository to auto's status
  // rules (pending until approved), it only never arms.
  const statusMode: PrEvaluationMode = chosen;
  const autoGloballyOff = chosen === 'auto' && !settings['prEvaluation.autoMergeAllowed'];
  const effectiveMode: PrEvaluationMode = autoGloballyOff ? 'advisory' : chosen;

  // The platform's own pull request is one a run opened: its row links the run, exactly as the
  // PR-feedback automation decides it (`origin !== 'other'`). The host's branch name is not
  // evidence, anyone can name a branch `auto/...`. A database lookup, so it comes before any
  // call to the host.
  const platformPr = await findPlatformPullRequest(prisma, connection.id, input.prNumber);
  if (!platformPr?.workflow) {
    return { outcome: 'skipped', reason: 'not a pull request the platform opened' };
  }
  const temporalWorkflowId = platformPr.workflow.temporalWorkflowId;
  // Everyone who launched a run of this work, and whoever asked for it: their own approval never
  // counts, and unless every one of them is matched by id on this repository's host the pull
  // request is never armed. Only a count reaches the row and the logs, never who they were.
  const launcher = await resolveLauncherSet(prisma, {
    repoHost: await deps.repoHost(repo),
    repoId: connection.id,
    runId: platformPr.runId,
    temporalWorkflowId,
    workRequestId: platformPr.workflow.workRequestId,
  });
  const { scm } = deps;

  let pr: PullRequestDetails | null;
  try {
    pr = await scm.getPullRequest(repo, input.prNumber);
  } catch (err) {
    if (isRetryableEvaluationError(err)) {
      throw err;
    }
    logWarn('pr evaluation: the pull request could not be read', {
      connectionId: connection.id,
      prNumber: input.prNumber,
      ...safeErrorMeta(err),
    });
    return { outcome: 'error', reason: 'the pull request could not be read' };
  }
  if (!pr) {
    return { outcome: 'skipped', reason: 'pull request not found' };
  }
  if (pr.merged || pr.state !== 'open') {
    return { outcome: 'skipped', reason: 'pull request is not open' };
  }

  const armedRow = await latestArmedRow(connection.id, input.prNumber);
  // The newest row that recorded an approval of the approver App as standing: its head's status
  // may have been earned by that approval alone.
  const priorBotRow = deps.approver ? await latestBotRow(connection.id, input.prNumber) : null;
  const context = settings['prEvaluation.requiredStatusContext'];
  // Set before any call that could arm, so a failure afterwards still cancels it.
  const armAttempt = { made: false };
  // A bot approval made by this evaluation and not yet recorded on a row. A retryable error in
  // that window must not leave it standing beside a `success` the retry may never replace.
  const unrecorded: { active: boolean; approvals: PullRequestReviewSummary[] } = {
    active: false,
    approvals: [],
  };

  try {
    // ── Policy: the registry is the floor; the repository file (from the BASE branch) can
    // only make it stricter.
    const floor: PolicyFloor = {
      highApprovers: settings['prEvaluation.highApprovers'],
      highLines: settings['prEvaluation.highLines'],
      lowApprovers: settings['prEvaluation.lowApprovers'],
      maxLowDirs: settings['prEvaluation.maxLowDirs'],
      maxLowFiles: settings['prEvaluation.maxLowFiles'],
      maxLowLines: settings['prEvaluation.maxLowLines'],
      sensitivePaths: settings['prEvaluation.sensitivePaths'],
      standardApprovers: settings['prEvaluation.standardApprovers'],
    };
    const policyText = await scm.fetchFileContent(repo, PR_POLICY_PATH, pr.baseBranch);
    let policyErrors: string[] = [];
    let policy: RepoPolicyFile | undefined;
    if (policyText !== null) {
      const parsed = parsePolicyFile(policyText);
      policyErrors = [...parsed.errors];
      policy = parsed.policy;
    }
    const merged = mergePolicy(floor, policy);
    if (merged.fileRejected) {
      policyErrors.push(...merged.warnings);
    }
    const effective = merged.effective;

    // ── Signals.
    const listed = await scm.listPullRequestFiles(repo, input.prNumber);
    const errors: string[] = [];
    if (listed.truncated) {
      errors.push('file list truncated');
    }
    const policyFileChanged = listed.files.some(
      (f) => f.path === PR_POLICY_PATH || f.previousPath === PR_POLICY_PATH
    );

    let scannerFindingCount = 0;
    const { diff, unscannable } = diffOf(listed.files);
    if (unscannable) {
      errors.push('changes too large to scan');
    }
    try {
      const scanned = await deps.scan(diff);
      scannerFindingCount = scanned.findings.length;
      if (scanned.incomplete) {
        errors.push('code security scan incomplete');
      }
    } catch (err) {
      logWarn('pr evaluation: the code security scan failed', {
        connectionId: connection.id,
        prNumber: input.prNumber,
        ...safeErrorMeta(err),
      });
      errors.push('code security scan failed');
    }

    const maxReviewSeverity = await loadMaxReviewSeverity(temporalWorkflowId, pr.headSha);

    const signals: EvaluationSignals = {
      draft: pr.draft,
      files: listed.files,
      maxReviewSeverity,
      policyFileChanged,
      scannerFindingCount,
      ...(errors.length > 0 ? { evaluationError: errors.join('; ') } : {}),
      ...(policyErrors.length > 0 ? { policyErrors } : {}),
    };
    const base = classify(signals, effective);
    const classification: Classification = {
      ...base,
      reasons: [
        ...base.reasons,
        ...merged.warnings.map((w) => infoReason('policy-warning', clip(w))),
        ...(autoGloballyOff
          ? [
              infoReason(
                'auto-merge-globally-disabled',
                'Auto mode is chosen but auto-merge is not allowed on this deployment; the status follows auto rules and nothing is armed.'
              ),
            ]
          : []),
      ],
    };

    const readiness = await readRules(deps, repo, pr.baseBranch, context);

    // ── Race check, immediately before anything is published: the head and the reviews are read
    // again. A moved head is somebody else's evaluation (the newer head has its own); the
    // approvals are counted from the list as it is now.
    const live = await scm.getPullRequest(repo, input.prNumber);
    if (!live || live.merged || live.state !== 'open') {
      return { outcome: 'skipped', reason: 'pull request is not open' };
    }
    if (live.headSha !== pr.headSha || live.baseBranch !== pr.baseBranch) {
      return { outcome: 'superseded', reason: 'the head moved during the evaluation' };
    }
    const reviews: PullRequestReviewSummary[] = await scm.listPullRequestReviews(
      repo,
      input.prNumber
    );
    const trusted = await trustedApprovers(
      scm,
      repo,
      reviews,
      pr.author ?? '',
      classification.requiredApprovers,
      pr.headSha,
      launcher
    );
    const approval = trusted.approval;
    if (trusted.excluded > 0) {
      classification.reasons.push(
        infoReason(
          'approvers-unverified',
          `${trusted.excluded} approving reviewer(s) were not counted: write access to the repository could not be confirmed.`
        )
      );
    }
    if (trusted.launcherExcluded > 0) {
      classification.reasons.push(
        infoReason(
          'launcher-excluded',
          `${trusted.launcherExcluded} distinct approver(s) who launched or requested this work were not counted.`
        )
      );
    }
    if (!launcher.resolved) {
      classification.reasons.push(
        infoReason(
          'launcher-unresolved',
          "Everyone who launched or requested this work could not be matched to a linked GitHub account on this repository's host, so their own approval cannot be told apart; auto-merge is never armed."
        )
      );
    }
    const evidenceThresholds: EvidenceThresholds = {
      minDistinctRequesters: settings['prEvaluation.autoMinDistinctRequesters'],
      minEvidence: settings['prEvaluation.autoMinEvidence'],
      minRepoEvidence: settings['prEvaluation.autoMinRepoEvidence'],
    };
    const scope = {
      ...(connection.team?.orgId ? { orgId: connection.team.orgId } : {}),
      teamId: connection.teamId ?? undefined,
    };
    const bot = deps.approver
      ? await runBotApproval({
          classification,
          connectionId: connection.id,
          context,
          deps,
          effectiveMode,
          evidenceOk: async () =>
            (
              await assessEvidence(
                connection.id,
                deps.now(),
                settings['prEvaluation.autoEvidenceMinChangedLines'],
                evidenceThresholds
              )
            ).satisfied,
          files: listed.files,
          filesTruncated: listed.truncated === true,
          launcherResolved: launcher.resolved,
          maxFiles: settings['prEvaluation.botApprovalMaxFiles'],
          maxLines: settings['prEvaluation.botApprovalMaxLines'],
          paths: settings['prEvaluation.botApprovalPaths'],
          pr: live,
          priorBotRow,
          prNumber: input.prNumber,
          readiness,
          recheck: () => rereadBotInputs(connection.id, scope, scm, repo, input.prNumber, live),
          repo,
          repoFlag: connection.prEvaluationBotApproval === true,
          reviews,
          switches: {
            autoMergeAllowed: settings['prEvaluation.autoMergeAllowed'] === true,
            botApprovalAllowed: settings['prEvaluation.botApprovalAllowed'] === true,
          },
          trustedApprovers: new Set(approval.approvers.map((login) => login.toLowerCase())),
        })
      : null;
    if (bot) {
      classification.reasons.push(...bot.reasons);
    }
    const botApproved = bot?.botApproved === true;
    unrecorded.active = botApproved;
    unrecorded.approvals = botApproved && bot ? bot.posted : [];
    const status = statusFor(classification, approval, statusMode, {
      evaluatorApproved: botApproved,
    });
    if (!status) {
      return { outcome: 'skipped', reason: 'evaluation is off for this repository' };
    }

    // ── Publish. The order is what keeps a merge from happening on a `success` nobody earned:
    // while an approval of the evaluator must be withdrawn, or an arming this evaluation will end
    // is still in place, a `success` may not be on the check. So a status that is not `success` goes
    // first (the final one when it is not, otherwise a fixed `pending`); then every approval is
    // dismissed; then the arming is cancelled; and only then the final status. A status that cannot
    // be posted throws before anything else is touched. Whether the final status was accepted is a
    // precondition of arming.
    const mustWithdraw =
      bot !== null && (bot.withdraw.length > 0 || (!botApproved && bot.hadOwnApproval));
    // Anything but `auto` can never arm, so an arming that is still there is going to be cancelled.
    const willDisarm = live.autoMerge.enabled && effectiveMode !== 'auto';
    const bankedApproval =
      bot !== null && !botApproved && (bot.hadOwnApproval || priorBotRow?.headSha === pr.headSha);
    const logMeta = { connectionId: connection.id };
    let statusPublished: StatusPublished | null = null;
    if ((mustWithdraw || willDisarm) && status.state === 'success') {
      if (!(await postPending(scm, repo, pr.headSha, context, EVALUATION_CHANGED_STATUS))) {
        throw botStatusNotPosted();
      }
    } else {
      statusPublished = await publishStatus(
        scm,
        repo,
        pr,
        input.prNumber,
        context,
        status,
        logMeta
      );
      if (!statusPublished.ok && (mustWithdraw || bankedApproval)) {
        throw botStatusNotPosted();
      }
    }
    if (bot && bot.withdraw.length > 0) {
      const dismissal = await dismissAll({
        approvals: bot.withdraw,
        connectionId: connection.id,
        prNumber: input.prNumber,
        repo,
        scm,
      });
      if (!dismissal.gone) {
        throw botNotWithdrawn();
      }
      if (!botApproved) {
        bot.state = 'withdrawn';
      }
      classification.reasons.push(...withdrawnReasons(dismissal.dismissed, pr.headSha));
    }
    let disarmedEarly = false;
    if (willDisarm) {
      await disarm(scm, repo, input.prNumber);
      disarmedEarly = true;
    }
    if (statusPublished === null) {
      statusPublished = await publishStatus(
        scm,
        repo,
        pr,
        input.prNumber,
        context,
        status,
        logMeta
      );
    }

    // ── Auto-merge decision (nothing is armed yet).
    let decision: AutoDecision = { blockers: [], eligible: false };
    let suppressed = false;
    if (effectiveMode === 'auto') {
      decision = await decideAuto({
        approvalSatisfied: approval.satisfied || botApproved,
        classification,
        connectionId: connection.id,
        context,
        deps,
        draft: live.draft,
        evidenceThresholds,
        launcherResolved: launcher.resolved,
        minChangedLines: settings['prEvaluation.autoEvidenceMinChangedLines'],
        readiness,
        statusPublished: statusPublished.ok,
      });
      if (!decision.eligible) {
        classification.reasons.push(
          infoReason(
            'auto-merge-blocked',
            `Auto-merge not enabled: ${decision.blockers.join('; ')}`
          )
        );
      } else if (!live.autoMerge.enabled) {
        // A person (or the host) turned off an arming the platform made: not ours to undo.
        const marker = await latestMarker(connection.id, input.prNumber, armedRow !== null);
        if (marker === AUTO_ARMED || marker === AUTO_SUPPRESSED) {
          suppressed = true;
          classification.reasons.push(
            infoReason(
              AUTO_SUPPRESSED,
              'Auto-merge was turned off after the platform armed it; the platform will not turn it on again.'
            )
          );
        }
      }
    }

    // ── The brief, then the row, then the arming.
    const brief = buildBrief(listed.files, classification, effective);
    const briefMarkdown = truncateBrief(brief.markdown);
    await postBrief(scm, repo, input.prNumber, briefMarkdown, connection.id);

    const row = await prisma.prEvaluation.create({
      data: {
        baseBranch: pr.baseBranch,
        // Whether the approver App's approval stands on this head, however the status came out:
        // the webhook and the sweep read it to withdraw an approval from a repository switched off.
        // An approval that had to be withdrawn is gone by now (a failed withdrawal threw instead).
        botApproved,
        brief: asJson({
          claimsToVerify: brief.claimsToVerify.slice(0, MAX_PERSISTED_CLAIMS),
          focus: brief.focus.slice(0, 20),
          markdown: briefMarkdown,
          skim: brief.skim.slice(0, MAX_PERSISTED_SKIM),
        }),
        // The facts the evidence gate counts, describing the head just evaluated.
        changedLines: listed.files.reduce((sum, f) => sum + f.additions + f.deletions, 0),
        connectionId: connection.id,
        headSha: pr.headSha,
        mode: statusMode,
        prNumber: input.prNumber,
        readiness: asJson({
          ...(readiness ?? {}),
          statusPublished,
          ...(bot && bot.state !== 'none'
            ? { botApproval: { eligible: bot.eligible, state: bot.state } }
            : {}),
        }),
        reasons: asJson(boundReasons(classification.reasons)),
        requesterId: launcher.requesterId,
        requiredApprovers: classification.requiredApprovers,
        riskClass: classification.riskClass,
        statusState: status.state,
        triggeredBy: input.trigger,
        // A row whose launcher set is unresolved can never count as reviewed evidence: the
        // requester's own approval could not be told apart, so no approval is credited.
        trustedApprovers: launcher.resolved ? approval.approvers.length : 0,
      },
      select: { id: true },
    });
    unrecorded.active = false;

    // An arming cancelled before the final status is only recorded here, on the row of this head.
    const autoMerge = disarmedEarly
      ? await recordEarlyDisarm(connection.id, input.prNumber, row.id, classification.reasons)
      : await applyAutoMerge({
          armAttempt,
          armedRow,
          connectionId: connection.id,
          deps,
          githubArmed: live.autoMerge.enabled,
          headSha: pr.headSha,
          prNumber: input.prNumber,
          reasons: classification.reasons,
          repo,
          rowId: row.id,
          wantsArmed: decision.eligible && !suppressed,
        });

    return {
      autoMerge,
      outcome: 'evaluated',
      riskClass: classification.riskClass,
      statusState: status.state,
    };
  } catch (err) {
    if (isRetryableEvaluationError(err)) {
      if (unrecorded.active) {
        await retractUnrecordedApproval({
          approvals: unrecorded.approvals,
          connectionId: connection.id,
          context,
          highApprovers: settings['prEvaluation.highApprovers'],
          mode: statusMode,
          pr,
          prNumber: input.prNumber,
          repo,
          scm,
          trigger: input.trigger,
        });
      }
      throw err;
    }
    return failClosed({
      armAttempt,
      connectionId: connection.id,
      context,
      err,
      highApprovers: settings['prEvaluation.highApprovers'],
      input,
      mode: statusMode,
      pr,
      repo,
      scm,
    });
  }
}

/** How many distinct approvers get a permission lookup; the rest are not counted. */
const MAX_APPROVER_LOOKUPS = 20;

/**
 * The approval count with only people who hold write access counted. The distinct approvers
 * (first 20 in review order) are each asked for their permission on the repository; a lookup
 * that errors, is refused or answers below `write` leaves that login out. The author is never
 * asked about (`approvalState` leaves them out first), and neither is anyone who launched or
 * requested the work (`excludedIdentities`), whose own approval never counts; `launcherExcluded`
 * is how many distinct approvers were set aside for that reason, a count and never who.
 */
async function trustedApprovers(
  scm: ScmProvider,
  repo: RepoRef,
  reviews: readonly PullRequestReviewSummary[],
  author: string,
  required: number,
  headSha: string,
  excludedIdentities?: ExcludedIdentities
): Promise<{ approval: ApprovalState; excluded: number; launcherExcluded: number }> {
  const everyone = approvalState(reviews, author, required, headSha).approvers;
  const candidates = approvalState(
    reviews,
    author,
    required,
    headSha,
    [],
    undefined,
    excludedIdentities
  ).approvers;
  const eligible = new Set<string>();
  for (const login of candidates.slice(0, MAX_APPROVER_LOOKUPS)) {
    try {
      const lookup = await scm.repoPermission(repo, login);
      if (lookup.ok && permissionMeets(lookup.permission, 'write')) {
        eligible.add(login.toLowerCase());
      }
    } catch {
      // Fail closed: an approver whose standing cannot be read does not count.
    }
  }
  const approval = approvalState(
    reviews,
    author,
    required,
    headSha,
    [],
    eligible,
    excludedIdentities
  );
  return {
    approval,
    excluded: candidates.length - approval.approvers.length,
    launcherExcluded: everyone.length - candidates.length,
  };
}

async function readRules(
  deps: EvaluatePullRequestDeps,
  repo: RepoRef,
  baseBranch: string,
  context: string
): Promise<BranchRules | null> {
  try {
    let expectedAppId: number | null = null;
    try {
      expectedAppId = await deps.expectedAppId(repo);
    } catch (err) {
      logWarn('pr evaluation: the platform App could not be resolved', safeErrorMeta(err));
    }
    return await deps.scm.readBranchRules(repo, baseBranch, context, expectedAppId);
  } catch (err) {
    if (isRetryableEvaluationError(err)) {
      throw err;
    }
    logWarn('pr evaluation: branch rules could not be read', safeErrorMeta(err));
    return null;
  }
}

/** The evidence gate for auto mode, read the same way by arming and by bot approval. */
async function assessEvidence(
  connectionId: string,
  now: Date,
  minChangedLines: number,
  thresholds: EvidenceThresholds
): Promise<{ satisfied: boolean; unmet: string[] }> {
  const evidence = await prEvaluationEvidence(prisma, connectionId, now, minChangedLines);
  return autoEvidenceAssessment(evidence, thresholds);
}

type BotStage = {
  /** The approval stands on the head, was confirmed in the review list, and may count for the status. */
  botApproved: boolean;
  /** Every condition for approving held (whether or not the submit then succeeded). */
  eligible: boolean;
  /** An own approval, of any commit, stood at some point of this stage. */
  hadOwnApproval: boolean;
  /** The approver's approvals standing after this stage's submit; set only with `botApproved`. */
  posted: PullRequestReviewSummary[];
  reasons: Reason[];
  state: 'approved' | 'none' | 'withdrawn' | 'refused';
  /** Every standing approval of the approver that must not stand; dismissed after the status. */
  withdraw: PullRequestReviewSummary[];
};

/** What a fresh, uncached read of the switches, the repository row and the pull request says. */
type FreshBotInputs = {
  moved: boolean;
  overrides: Partial<BotApprovalInput>;
  /** The path allowlist as it is now; applied to the listed files by the caller. */
  paths: unknown;
};

/**
 * Reads again, without the settings cache, everything an approval depends on that can change while
 * an evaluation runs: the three switches, the repository's mode, flag and activity, and the live
 * pull request's state, head, base branch and draft flag. Several evaluations of one pull request
 * can run at once, and the cache lives ~30 s per process, so a value read at the start can be stale
 * by the time the approval is submitted or counted.
 */
async function rereadBotInputs(
  connectionId: string,
  scope: { orgId?: string; teamId?: string },
  scm: ScmProvider,
  repo: RepoRef,
  prNumber: number,
  evaluated: PullRequestDetails
): Promise<FreshBotInputs> {
  invalidateSettingsCache();
  const fresh = await resolveSettings(
    [
      'prEvaluation.enabled',
      'prEvaluation.defaultMode',
      'prEvaluation.autoMergeAllowed',
      'prEvaluation.botApprovalAllowed',
      'prEvaluation.botApprovalPaths',
    ],
    scope
  );
  const row = await prisma.connection.findFirst({
    select: { isActive: true, prEvaluationBotApproval: true, prEvaluationMode: true },
    where: { id: connectionId, type: 'git_repo' },
  });
  const live = await scm.getPullRequest(repo, prNumber);
  const chosen = (row?.prEvaluationMode ?? fresh['prEvaluation.defaultMode']) as PrEvaluationMode;
  const autoAllowed = fresh['prEvaluation.autoMergeAllowed'] === true;
  let effectiveMode: PrEvaluationMode = chosen;
  if (!(fresh['prEvaluation.enabled'] === true && row?.isActive === true) || chosen === 'off') {
    effectiveMode = 'off';
  } else if (chosen === 'auto' && !autoAllowed) {
    effectiveMode = 'advisory';
  }
  return {
    moved:
      !live ||
      live.merged ||
      live.state !== 'open' ||
      live.headSha !== evaluated.headSha ||
      live.baseBranch !== evaluated.baseBranch,
    overrides: {
      autoMergeAllowed: autoAllowed,
      botApprovalAllowed: fresh['prEvaluation.botApprovalAllowed'] === true,
      draft: live?.draft,
      effectiveMode,
      repoBotApproval: row?.prEvaluationBotApproval === true,
    },
    paths: fresh['prEvaluation.botApprovalPaths'],
  };
}

/**
 * The approver App's approval of this head. Submits it when every condition in
 * `botApprovalRefusals` holds and none stands yet; names every standing approval of its own, of
 * any commit, for withdrawal when any does not. It dismisses nothing itself: the caller does, after
 * the status, through the platform credential. The App's token is minted only for a pull request
 * that passed every other condition, checked again from fresh reads immediately before the submit
 * and again once the approval is confirmed, and is revoked when the stage ends. Fails closed: any
 * error, thrown or not, leaves `botApproved` false, and the stage never fails the evaluation; the
 * error's name, never its text, is logged.
 */
async function runBotApproval(args: {
  classification: Classification;
  connectionId: string;
  context: string;
  deps: EvaluatePullRequestDeps;
  effectiveMode: PrEvaluationMode;
  evidenceOk: () => Promise<boolean>;
  files: readonly ChangedFile[];
  filesTruncated: boolean;
  launcherResolved: boolean;
  maxFiles: number;
  maxLines: number;
  paths: unknown;
  pr: PullRequestDetails;
  priorBotRow: { botApproved: boolean; headSha: string } | null;
  prNumber: number;
  readiness: BranchRules | null;
  recheck: () => Promise<FreshBotInputs>;
  repo: RepoRef;
  repoFlag: boolean;
  reviews: readonly PullRequestReviewSummary[];
  /**
   * The lower-cased logins of the approvers that count for the status: trusted, and not anyone who
   * launched or requested the work. Only their approval of the head lifts a sticky objection.
   */
  trustedApprovers: ReadonlySet<string>;
  switches: { autoMergeAllowed: boolean; botApprovalAllowed: boolean };
}): Promise<BotStage> {
  const { approver, scm } = args.deps;
  const { pr, repoFlag } = args;
  const meta = { connectionId: args.connectionId, prNumber: args.prNumber };
  const result: BotStage = {
    botApproved: false,
    eligible: false,
    hadOwnApproval: false,
    posted: [],
    reasons: [],
    state: repoFlag ? 'refused' : 'none',
    withdraw: [],
  };
  if (!approver) {
    return result;
  }
  const refuse = (code: string, message: string): void => {
    result.reasons.push(infoReason(`bot-approval-refused:${code}`, message));
  };
  let session: ApproverSession | undefined;
  let botLogin: string | null = null;
  let standing: PullRequestReviewSummary[] = [];
  let submittedOk = false;
  let allLogins: readonly string[] = [];
  try {
    const config = await loadApproverConfig(approver);
    const identity = await approverLogins(approver, config);
    botLogin = identity.active;
    const everyLogin = identity.all;
    allLogins = everyLogin;
    /** An approval of an App that was removed or replaced: it must not stand, even beside a valid one. */
    const retiredOnly = (list: readonly PullRequestReviewSummary[]): PullRequestReviewSummary[] =>
      approvalsOf(list, everyLogin).filter((r) => r.login.toLowerCase() !== botLogin);
    standing = approvalsOf(args.reviews, everyLogin);
    result.hadOwnApproval = standing.length > 0;
    const existing = botLogin ? findOwnApproval(args.reviews, botLogin, pr.headSha) : null;
    if (!config && (repoFlag || args.priorBotRow?.botApproved === true)) {
      // Its reviews cannot be told from anyone's without its slug: nothing is withdrawn.
      result.reasons.push(
        infoReason(
          'bot-approval-credentials-missing',
          'The approver GitHub App is not configured, so an approval it gave cannot be recognised or withdrawn.'
        )
      );
    }
    const ownDismissedOf = (list: readonly PullRequestReviewSummary[]): number =>
      list.filter(
        (r) =>
          r.state === 'DISMISSED' &&
          everyLogin.includes(r.login.toLowerCase()) &&
          r.commitId === pr.headSha
      ).length;
    /** The evaluation rows of this pull request, read once: they cannot change during the stage. */
    let history: Promise<PrHistory> | undefined;
    /** The inputs that depend on the review list, taken from the list as it is when asked. */
    const fromReviews = async (
      list: readonly PullRequestReviewSummary[]
    ): Promise<{ humanObjection: boolean; notSuppressed: boolean }> => {
      const author = pr.author ?? '';
      history ??= readPrHistory(args.connectionId, args.prNumber, pr.headSha);
      const seen = await history;
      let humanObjection = hasHumanObjection(list, author);
      if (!humanObjection) {
        // A request for changes a person dismissed is no longer in the list, yet it was not a
        // decision to approve: it stands until a person approves this head.
        const doubt =
          seen.objection === 'unknown' && list.some((r) => isDismissedHumanReview(r, author));
        if (
          (seen.objection === 'seen' || doubt) &&
          approvalState(list, author, 1, pr.headSha, [], args.trustedApprovers).approvers.length ===
            0
        ) {
          humanObjection = true;
        }
      }
      return {
        humanObjection,
        // Own dismissals beyond the platform's recorded withdrawals were a person's.
        notSuppressed: !(seen.suppressed || ownDismissedOf(list) > seen.withdrawn),
      };
    };
    const initial = await fromReviews(args.reviews);
    if (initial.humanObjection) {
      result.reasons.push(
        infoReason(
          HUMAN_OBJECTION_SEEN,
          'A reviewer has a request for changes on this pull request; the evaluator will not approve it until a person approves the head.'
        )
      );
    }
    if (!initial.notSuppressed) {
      result.reasons.push(
        infoReason(
          BOT_SUPPRESSED,
          'A person dismissed the evaluator approval on this pull request; the evaluator will not approve it again.'
        )
      );
    }
    const base = {
      ...initial,
      approverAppConfigured: config !== null,
      autoEligible: args.classification.autoEligible,
      autoMergeAllowed: args.switches.autoMergeAllowed,
      botApprovalAllowed: args.switches.botApprovalAllowed,
      botLogin,
      changedFiles: args.files.length,
      changedLines: args.files.reduce((sum, f) => sum + f.additions + f.deletions, 0),
      context: args.context,
      draft: pr.draft,
      effectiveMode: args.effectiveMode,
      exclusionCount: args.classification.reasons.filter((r) => r.severity === 'exclusion').length,
      headSha: pr.headSha,
      launcherResolved: args.launcherResolved,
      maxFiles: args.maxFiles,
      maxLines: args.maxLines,
      noNetTestDeletion: !hasNetTestDeletion(args.files),
      pathsAllowed: changedPathsAllowed(args.files, args.paths, args.filesTruncated),
      prAuthorLogin: pr.author ?? null,
      readiness: args.readiness,
      repoBotApproval: repoFlag,
      requiredApprovers: args.classification.requiredApprovers,
      riskClass: args.classification.riskClass,
    };
    const ineligible = (code: string, conditions: BotApprovalCondition[], text?: string): void => {
      if (repoFlag || standing.length > 0) {
        refuse(code, text ?? `Bot approval was not given: ${conditions.join(', ')}.`);
      }
    };
    /** The fresh reads against the same conditions; null when nothing changed and all hold. */
    const stale = async (
      reviewsNow?: readonly PullRequestReviewSummary[]
    ): Promise<{
      code: string;
      conditions: BotApprovalCondition[];
      text?: string;
    } | null> => {
      const fresh = await args.recheck();
      const derived = reviewsNow ? await fromReviews(reviewsNow) : {};
      const conditions = botApprovalRefusalConditions({
        ...base,
        ...fresh.overrides,
        pathsAllowed: changedPathsAllowed(args.files, fresh.paths, args.filesTruncated),
        ...derived,
        approverClientOk: true,
        evidenceSatisfied: true,
      });
      if (fresh.moved) {
        return {
          code: 'recheck-changed',
          conditions,
          text: 'Bot approval was not given: the pull request changed during the evaluation.',
        };
      }
      return conditions.length > 0
        ? { code: `recheck-${conditions[0] ?? 'unknown'}`, conditions }
        : null;
    };

    // Cheapest first, and the token last: each step runs only when every earlier one held.
    let conditions = botApprovalRefusalConditions({
      ...base,
      approverClientOk: true,
      evidenceSatisfied: true,
    });
    if (conditions.length === 0 && !(await args.evidenceOk())) {
      conditions = botApprovalRefusalConditions({
        ...base,
        approverClientOk: true,
        evidenceSatisfied: false,
      });
    }
    let clientFailure: string | null = null;
    if (conditions.length === 0) {
      const got = await approver.getClient(args.repo);
      if (got.ok) {
        session = got.client;
      } else {
        clientFailure = got.reason;
        conditions = botApprovalRefusalConditions({
          ...base,
          approverClientOk: false,
          evidenceSatisfied: true,
        });
      }
    }
    if (conditions.length > 0) {
      ineligible(
        clientFailure ? `client-${clientFailure}` : (conditions[0] ?? 'unknown'),
        conditions
      );
      result.withdraw = standing;
      return result;
    }

    // Immediately before the approval is used or made: nothing it depends on may have changed.
    const before = await stale();
    if (before) {
      ineligible(before.code, before.conditions, before.text);
      result.withdraw = standing;
      return result;
    }
    result.eligible = true;
    if (existing) {
      result.botApproved = true;
      if (args.priorBotRow?.headSha !== pr.headSha || !args.priorBotRow.botApproved) {
        // No row records this approval (an earlier attempt's retraction may have failed): a later
        // failure must be able to retract it.
        result.posted = [existing];
      }
      result.withdraw = retiredOnly(args.reviews);
      result.state = 'approved';
      result.reasons.push(
        infoReason('bot-approval-present', 'The evaluator approval already stands on this head.')
      );
      return result;
    }
    const submitted = await approver.submit(session as ApproverSession, args.repo, args.prNumber, {
      body: botApprovalBody(pr.headSha),
      headSha: pr.headSha,
    });
    if (!submitted.ok) {
      refuse(`submit-${submitted.reason}`, 'The evaluator could not submit its approval.');
      // No approval was made here, but one of a retired App must not stand because this one failed.
      result.withdraw = retiredOnly(args.reviews);
      return result;
    }
    result.hadOwnApproval = true;
    submittedOk = true;
    // Believe the review list, not the answer to the submit.
    const relisted = await scm.listPullRequestReviews(args.repo, args.prNumber);
    if (!botLogin || !findOwnApproval(relisted, botLogin, pr.headSha)) {
      refuse('not-confirmed', 'The evaluator approval did not show in the review list.');
      return result;
    }
    // And once more before it may count: a switch can flip between the submit and the status.
    const after = await stale(relisted);
    if (after) {
      result.eligible = false;
      ineligible(after.code, after.conditions, after.text);
      result.withdraw = approvalsOf(relisted, everyLogin);
      return result;
    }
    result.botApproved = true;
    result.posted = approvalsOf(relisted, everyLogin);
    result.withdraw = retiredOnly(relisted);
    result.state = 'approved';
    result.reasons.push(infoReason('bot-approval-posted', 'The evaluator approved this head.'));
    return result;
  } catch (err) {
    // Fail closed, and say what failed without its text.
    logWarn('pr evaluation: the bot approval stage failed', { ...meta, ...safeErrorMeta(err) });
    result.botApproved = false;
    result.withdraw = standing;
    result.reasons = result.reasons.filter((r) => !BOT_REASON_CODES.includes(r.code));
    if (submittedOk) {
      // The submit succeeded but what followed failed: `standing` predates the new approval, so
      // read the list again and withdraw everything of the App's. A list that cannot be read
      // twice leaves an approval nobody can name, so the activity is retried instead.
      try {
        const fresh = await scm.listPullRequestReviews(args.repo, args.prNumber);
        result.withdraw = approvalsOf(fresh, allLogins);
        result.hadOwnApproval = true;
      } catch {
        throw botNotWithdrawn();
      }
    }
    return result;
  } finally {
    try {
      await session?.release();
    } catch {
      // Best effort: the token expires by itself.
    }
  }
}

/** Every condition for arming auto-merge, each checked and each named when it fails. */
async function decideAuto(args: {
  approvalSatisfied: boolean;
  classification: Classification;
  context: string;
  deps: EvaluatePullRequestDeps;
  draft: boolean;
  launcherResolved: boolean;
  connectionId: string;
  evidenceThresholds: EvidenceThresholds;
  minChangedLines: number;
  readiness: BranchRules | null;
  statusPublished: boolean;
}): Promise<AutoDecision> {
  const { classification } = args;
  const blockers: string[] = [];
  if (!classification.autoEligible) {
    blockers.push('the change is not eligible');
  }
  if (classification.riskClass !== 'LOW') {
    blockers.push(`risk class is ${classification.riskClass}`);
  }
  blockers.push(
    ...autoArmingRefusals({
      approvalSatisfied: args.approvalSatisfied,
      context: args.context,
      draft: args.draft,
      launcherResolved: args.launcherResolved,
      readiness: args.readiness,
      statusPublished: args.statusPublished,
    })
  );
  // Only worth a query when everything cheaper already holds.
  if (blockers.length === 0) {
    const assessment = await assessEvidence(
      args.connectionId,
      args.deps.now(),
      args.minChangedLines,
      args.evidenceThresholds
    );
    for (const unmet of assessment.unmet) {
      blockers.push(`evidence gate not met, ${unmet}`);
    }
  }
  return { blockers, eligible: blockers.length === 0 };
}

/** Sets the commit status and reports whether the host accepted it, without the host's text. */
async function publishStatus(
  scm: ScmProvider,
  repo: RepoRef,
  pr: PullRequestDetails,
  prNumber: number,
  context: string,
  status: { state: 'pending' | 'success' | 'failure'; description: string },
  log: { connectionId: string }
): Promise<StatusPublished> {
  try {
    const set = await scm.setCommitStatus(repo, pr.headSha, { context, ...status });
    if (!set.ok) {
      logWarn('pr evaluation: the commit status was refused', {
        connectionId: log.connectionId,
        prNumber,
        reason: clip(set.reason ?? 'refused', 200),
      });
      return { ok: false, reason: 'refused' };
    }
    return { ok: true };
  } catch (err) {
    logWarn('pr evaluation: the commit status could not be set', {
      connectionId: log.connectionId,
      prNumber,
      ...safeErrorMeta(err),
    });
    return { ok: false, reason: 'error' };
  }
}

async function postBrief(
  scm: ScmProvider,
  repo: RepoRef,
  prNumber: number,
  markdown: string,
  connectionId: string
): Promise<void> {
  try {
    await scm.upsertMarkedComment(repo, prNumber, BRIEF_MARKER, markdown);
  } catch (err) {
    logWarn('pr evaluation: the brief could not be posted', {
      connectionId,
      prNumber,
      ...safeErrorMeta(err),
    });
  }
}

/** The arming was cancelled before the final status; this records it on the evaluation's row. */
async function recordEarlyDisarm(
  connectionId: string,
  prNumber: number,
  rowId: string,
  reasons: readonly Reason[]
): Promise<'disabled'> {
  await recordDisarmed(connectionId, prNumber, { id: rowId, reasons });
  return 'disabled';
}

/**
 * Carries out the arming decision against what GitHub actually shows, never against what a
 * database row remembers:
 *
 * - wanted and already armed for this head: nothing to do;
 * - wanted and armed for another (or an unknown) head: disarmed, then armed again for this head;
 * - wanted and not armed: armed, pinned to this head;
 * - not wanted and armed on GitHub, by anyone: disarmed;
 * - not wanted and not armed: nothing.
 *
 * A disarm that cannot be shown to have worked throws a retryable failure instead of returning.
 */
async function applyAutoMerge(args: {
  armAttempt: { made: boolean };
  armedRow: ArmedRow;
  connectionId: string;
  deps: EvaluatePullRequestDeps;
  githubArmed: boolean;
  headSha: string;
  prNumber: number;
  reasons: readonly Reason[];
  repo: RepoRef;
  rowId: string;
  wantsArmed: boolean;
}): Promise<NonNullable<EvaluatePullRequestResult['autoMerge']>> {
  const { repo, rowId, prNumber } = args;
  const { scm } = args.deps;

  const recordArmed = async (): Promise<boolean> => {
    try {
      await prisma.prEvaluation.update({
        data: {
          autoMergeEnabled: true,
          reasons: asJson(
            boundReasons([
              ...args.reasons,
              infoReason(AUTO_ARMED, 'The platform enabled auto-merge for this head commit.'),
            ])
          ),
        },
        where: { id: rowId },
      });
      return true;
    } catch (err) {
      // An arming the database does not know about would never be cancelled: take it back.
      logWarn('pr evaluation: auto-merge is armed but could not be recorded; cancelling it', {
        prNumber,
        ...safeErrorMeta(err),
      });
      await disarm(scm, repo, prNumber);
      await recordDisarmed(args.connectionId, prNumber, { id: rowId, reasons: args.reasons });
      return false;
    }
  };

  if (!args.wantsArmed) {
    if (!args.githubArmed) {
      return 'not-eligible';
    }
    await disarm(scm, repo, prNumber);
    await recordDisarmed(args.connectionId, prNumber, {
      id: rowId,
      reasons: args.reasons,
    });
    return 'disabled';
  }

  let disarmedFirst = false;
  if (args.githubArmed) {
    if (args.armedRow?.headSha === args.headSha) {
      // Armed for this very commit already (a review changed, the head did not).
      return (await recordArmed()) ? 'unchanged' : 'disabled';
    }
    await disarm(scm, repo, prNumber);
    disarmedFirst = true;
  }
  args.armAttempt.made = true;
  const armed = await scm.enableAutoMerge(repo, prNumber, {
    expectedHeadSha: args.headSha,
    method: 'SQUASH',
  });
  if (!armed.ok) {
    logWarn('pr evaluation: auto-merge was refused', {
      prNumber,
      reason: clip(armed.reason ?? 'refused', 200),
    });
    if (disarmedFirst) {
      await recordDisarmed(args.connectionId, prNumber, { id: rowId, reasons: args.reasons });
      return 'disabled';
    }
    return 'not-eligible';
  }
  return (await recordArmed()) ? 'enabled' : 'disabled';
}

/**
 * Best effort, before a retryable failure is rethrown: the status goes back to `pending` and the
 * approval this evaluation made (recorded on no row yet, so no sweep would find it) is dismissed.
 * The retry evaluates afresh and approves again if it still qualifies. Nothing here may throw.
 */
async function retractUnrecordedApproval(args: {
  approvals: readonly PullRequestReviewSummary[];
  connectionId: string;
  context: string;
  highApprovers: number;
  mode: PrEvaluationMode;
  pr: PullRequestDetails;
  prNumber: number;
  repo: RepoRef;
  scm: ScmProvider;
  trigger: string;
}): Promise<void> {
  // Each step stands alone: a status the host will not take must not leave the approval standing.
  try {
    const out = await dismissAll({
      approvals: args.approvals,
      connectionId: args.connectionId,
      prNumber: args.prNumber,
      repo: args.repo,
      scm: args.scm,
    });
    const reasons = withdrawnReasons(out.dismissed, args.pr.headSha).filter(
      (r) => r.code === BOT_WITHDRAWN
    );
    if (reasons.length > 0) {
      // Without a row saying the platform made these dismissals, the retry counts them as a
      // person's (`readPrHistory` withdrawn count) and suppresses the bot on this pull request.
      await prisma.prEvaluation.create({
        data: {
          baseBranch: args.pr.baseBranch,
          brief: asJson(EMPTY_BRIEF),
          connectionId: args.connectionId,
          headSha: args.pr.headSha,
          mode: args.mode,
          prNumber: args.prNumber,
          reasons: asJson(reasons),
          requiredApprovers: args.highApprovers,
          riskClass: 'HIGH',
          statusState: 'pending',
          triggeredBy: args.trigger,
        },
      });
    }
  } catch (err) {
    logWarn('pr evaluation: an unrecorded bot approval could not be retracted', safeErrorMeta(err));
  }
  try {
    await postPending(
      args.scm,
      args.repo,
      args.pr.headSha,
      args.context,
      EVALUATION_CHANGED_STATUS
    );
  } catch (err) {
    logWarn(
      'pr evaluation: the status behind a retracted approval was not reset',
      safeErrorMeta(err)
    );
  }
}

/**
 * An unexpected error while evaluating: class HIGH, status `failure`, any arming GitHub shows
 * cancelled. The bookkeeping steps are best effort and independent; the disarm is not, and a
 * disarm that cannot be proven throws so the activity is retried.
 */
async function failClosed(args: {
  armAttempt: { made: boolean };
  connectionId: string;
  context: string;
  err: unknown;
  highApprovers: number;
  input: PrEvaluationInput;
  mode: PrEvaluationMode;
  pr: PullRequestDetails;
  repo: RepoRef;
  scm: ScmProvider;
}): Promise<EvaluatePullRequestResult> {
  const { err, pr, scm, repo, input } = args;
  const meta = safeErrorMeta(err);
  logWarn('pr evaluation: the evaluation failed and was treated as high risk', {
    connectionId: args.connectionId,
    prNumber: input.prNumber,
    ...meta,
  });
  const message = `evaluation failed (${meta.errorName}${meta.status ? ` ${meta.status}` : ''})`;
  const needsDisarm = pr.autoMerge.enabled || args.armAttempt.made;
  try {
    await prisma.prEvaluation.create({
      data: {
        baseBranch: pr.baseBranch,
        brief: asJson(EMPTY_BRIEF),
        connectionId: args.connectionId,
        headSha: pr.headSha,
        mode: args.mode,
        prNumber: input.prNumber,
        reasons: asJson([
          {
            code: 'evaluation-error',
            message: `Evaluation failed: ${message}`,
            severity: 'exclusion',
          },
          ...(needsDisarm
            ? [infoReason(AUTO_DISARMED, 'The platform turned auto-merge off after a failure.')]
            : []),
        ]),
        requiredApprovers: args.highApprovers,
        riskClass: 'HIGH',
        statusState: 'failure',
        triggeredBy: input.trigger,
      },
    });
  } catch (persistErr) {
    logWarn(
      'pr evaluation: the failed evaluation could not be recorded',
      safeErrorMeta(persistErr)
    );
  }
  try {
    await scm.setCommitStatus(repo, pr.headSha, {
      context: args.context,
      description: 'HIGH risk: evaluation failed, treated as high risk',
      state: 'failure',
    });
  } catch (statusErr) {
    logWarn('pr evaluation: the failure status could not be set', safeErrorMeta(statusErr));
  }
  if (needsDisarm) {
    await disarm(scm, repo, input.prNumber);
    await recordDisarmed(args.connectionId, input.prNumber, null);
  }
  return { outcome: 'error', reason: message, riskClass: 'HIGH', statusState: 'failure' };
}
