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
  BRIEF_MARKER,
  buildBrief,
  type ChangedFile,
  type Classification,
  classify,
  type EvaluationSignals,
  type ExcludedIdentities,
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
import { resolveGitHubConfig } from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure } from '@temporalio/activity';
import { logWarn } from '../lib/activityLog.js';
import { scanDiffForCodeIssuesDetailed } from '../lib/codeSecurityScanner.js';
import { resolveLauncherSet } from '../lib/prLauncher.js';
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
const MARKER_CODES = [AUTO_ARMED, AUTO_DISARMED, AUTO_SUPPRESSED] as const;
type ArmMarker = (typeof MARKER_CODES)[number];
/** Rows read, newest first and a page at a time, when looking for the platform's newest marker. */
const MARKER_SCAN_ROWS = 500;
const MARKER_SCAN_PAGE = 100;

export type EvaluatePullRequestResult = {
  outcome: 'skipped' | 'evaluated' | 'error' | 'superseded';
  riskClass?: 'LOW' | 'STANDARD' | 'HIGH';
  statusState?: 'pending' | 'success' | 'failure';
  autoMerge?: 'enabled' | 'disabled' | 'not-eligible' | 'unchanged';
  reason?: string;
};

export type EvaluatePullRequestDeps = {
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

function boundReasons(reasons: readonly Reason[]): Reason[] {
  return reasons.slice(0, MAX_PERSISTED_REASONS).map((reason) => ({
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

/**
 * Evaluation is off for this pull request (the feature, or this repository). A pull request the
 * platform armed earlier must not stay armed: when an earlier row recorded an arming, GitHub is
 * asked and its real state is acted on. With no such row nothing is called.
 */
async function skipAndDisarm(
  connection: { id: string },
  input: PrEvaluationInput,
  deps: EvaluatePullRequestDeps,
  repo: RepoRef,
  reason: string
): Promise<EvaluatePullRequestResult> {
  const skipped: EvaluatePullRequestResult = { outcome: 'skipped', reason };
  const armedRow = await latestArmedRow(connection.id, input.prNumber);
  if (!armedRow) {
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
  if (pr && pr.state === 'open' && pr.autoMerge.enabled) {
    await disarm(scm, repo, input.prNumber);
    await recordDisarmed(connection.id, input.prNumber, armedRow);
    return { ...skipped, autoMerge: 'disabled' };
  }
  return skipped;
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
  const context = settings['prEvaluation.requiredStatusContext'];
  // Set before any call that could arm, so a failure afterwards still cancels it.
  const armAttempt = { made: false };

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
    if (live.headSha !== pr.headSha) {
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
    const status = statusFor(classification, approval, statusMode);
    if (!status) {
      return { outcome: 'skipped', reason: 'evaluation is off for this repository' };
    }

    // ── Publish: the status first. Whether the host accepted it is a precondition of arming.
    const statusPublished = await publishStatus(scm, repo, pr, input.prNumber, context, status, {
      connectionId: connection.id,
    });

    // ── Auto-merge decision (nothing is armed yet).
    let decision: AutoDecision = { blockers: [], eligible: false };
    let suppressed = false;
    if (effectiveMode === 'auto') {
      decision = await decideAuto({
        approvalSatisfied: approval.satisfied,
        classification,
        connectionId: connection.id,
        context,
        deps,
        draft: live.draft,
        evidenceThresholds: {
          minDistinctRequesters: settings['prEvaluation.autoMinDistinctRequesters'],
          minEvidence: settings['prEvaluation.autoMinEvidence'],
          minRepoEvidence: settings['prEvaluation.autoMinRepoEvidence'],
        },
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
        readiness: asJson({ ...(readiness ?? {}), statusPublished }),
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

    const autoMerge = await applyAutoMerge({
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
    const evidence = await prEvaluationEvidence(
      prisma,
      args.connectionId,
      args.deps.now(),
      args.minChangedLines
    );
    const assessment = autoEvidenceAssessment(evidence, args.evidenceThresholds);
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
