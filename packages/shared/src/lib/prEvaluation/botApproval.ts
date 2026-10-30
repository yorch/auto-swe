/**
 * Whether the approver App may submit an approving review on a platform pull request, as a pure
 * function. It fails closed: every input must be strictly the expected value, and every unmet
 * condition is reported, so an empty list is the only way to "yes". Refusal text is fixed and
 * names the condition only: no logins, ids or free text.
 */
import { type BranchRulesLike, branchRuleRefusals } from './arming.js';
import { isTestFile, isValidGlob, MAX_BOT_APPROVAL_PATHS, matchesAny } from './paths.js';
import type { ChangedFile, PrEvaluationMode, RiskClass } from './types.js';

export const BOT_APPROVAL_CONDITIONS = [
  'effective-mode-auto',
  'auto-merge-allowed',
  'bot-approval-allowed',
  'repo-bot-approval',
  'approver-app-configured',
  'approver-client-ok',
  'not-draft',
  'risk-low',
  'auto-eligible',
  'no-exclusions',
  'evidence-satisfied',
  'launcher-resolved',
  'allows-auto-merge',
  'status-required',
  'status-pinned',
  'dismiss-stale-reviews',
  'author-differs',
  'head-sha',
  'no-human-objection',
  'not-suppressed',
  'bot-max-lines',
  'bot-max-files',
  'bot-paths-allowed',
  'no-net-test-deletion',
  'no-stricter-approver-count',
] as const;

export type BotApprovalCondition = (typeof BOT_APPROVAL_CONDITIONS)[number];

const REFUSAL: Record<BotApprovalCondition, string> = {
  'allows-auto-merge': 'the repository does not provably allow auto-merge',
  'approver-app-configured': 'the approver GitHub App is not configured',
  'approver-client-ok': 'the approver GitHub App is not usable on this repository',
  'author-differs': 'the approver is not provably different from the pull request author',
  'auto-eligible': 'the change is not eligible for auto-merge',
  'auto-merge-allowed': 'auto-merge is not enabled platform-wide',
  'bot-approval-allowed': 'bot approval is not enabled platform-wide',
  'bot-max-files': 'the change touches more files than a bot approval allows',
  'bot-max-lines': 'the change carries more lines than a bot approval allows',
  'bot-paths-allowed': 'the change touches a path a bot approval does not cover',
  'dismiss-stale-reviews': 'the base branch does not provably dismiss stale approvals on a push',
  'effective-mode-auto': 'the effective evaluation mode is not auto',
  'evidence-satisfied': 'the auto-merge evidence requirement is not met',
  'head-sha': 'the head commit is unknown',
  'launcher-resolved': 'a launcher of this work is not matched to a linked account',
  'no-exclusions': 'the change has an auto-merge exclusion',
  'no-human-objection': 'a reviewer has requested changes',
  'no-net-test-deletion': 'the change deletes more test code than it adds',
  'no-stricter-approver-count': 'more than one approver is required for this change',
  'not-draft': 'the pull request is not ready for review',
  'not-suppressed': 'a person dismissed the evaluator approval on this pull request',
  'repo-bot-approval': 'bot approval is not enabled for this repository',
  'risk-low': 'the risk class is not LOW',
  'status-pinned': 'the evaluation status is not provably pinned to the platform App',
  'status-required': 'the evaluation status is not provably a required check',
};

export interface BotApprovalInput {
  /** The mode that arms auto-merge, after any downgrade. */
  effectiveMode: PrEvaluationMode | undefined;
  autoMergeAllowed: boolean | undefined;
  botApprovalAllowed: boolean | undefined;
  /** The per-repository switch. */
  repoBotApproval: boolean | undefined;
  approverAppConfigured: boolean | undefined;
  /** The approver App is installed on the repository, on the same host, and is not the platform App. */
  approverClientOk: boolean | undefined;
  draft: boolean | undefined;
  riskClass: RiskClass | undefined;
  autoEligible: boolean | undefined;
  exclusionCount: number | undefined;
  /** Deployment and repository evidence both satisfied. */
  evidenceSatisfied: boolean | undefined;
  launcherResolved: boolean | undefined;
  readiness: BranchRulesLike | null | undefined;
  /** The status context the evaluator publishes. */
  context: string;
  botLogin: string | null | undefined;
  prAuthorLogin: string | null | undefined;
  headSha: string | null | undefined;
  /** Some reviewer other than the author and a bot has a standing request for changes. */
  humanObjection: boolean | undefined;
  /** No person dismissed an approval of the evaluator on this pull request, now or earlier. */
  notSuppressed: boolean | undefined;
  /** Every line added or deleted over every listed file. */
  changedLines: number | undefined;
  changedFiles: number | undefined;
  /** The bot-specific hard caps, from the registry. */
  maxLines: number | undefined;
  maxFiles: number | undefined;
  /** No test file loses more lines than it gains, none is removed or moved out of the test globs. */
  noNetTestDeletion: boolean | undefined;
  /** Every changed path, and a rename's previous path, is on the bot approval allowlist. */
  pathsAllowed: boolean | undefined;
  /**
   * Approvers the evaluation requires for this change, after the policy merge. A bot approval
   * stands in for the platform default of one; a repository or deployment that asked for more
   * never has it replaced by the bot.
   */
  requiredApprovers: number | undefined;
}

/**
 * True when a test file loses more lines than it gains, is removed, or is renamed to a path that
 * is no test file. A count that is not a finite number counts as a deletion. Looks at every file.
 */
export function hasNetTestDeletion(files: readonly ChangedFile[]): boolean {
  return files.some((f) => {
    const wasTest =
      isTestFile(f.path) || (f.previousPath !== undefined && isTestFile(f.previousPath));
    if (!wasTest) {
      return false;
    }
    if (f.status === 'removed') {
      return true;
    }
    if (f.previousPath !== undefined && isTestFile(f.previousPath) && !isTestFile(f.path)) {
      return true;
    }
    return !(
      Number.isFinite(f.additions) &&
      Number.isFinite(f.deletions) &&
      f.deletions <= f.additions
    );
  });
}

/**
 * Whether every listed file, by its path and (for a rename) its previous path, matches the
 * allowlist. False for an empty or malformed allowlist, no files, a truncated list, or any
 * malformed path: it cannot say yes unless it saw every path and each one is on the list.
 */
export function changedPathsAllowed(
  files: readonly ChangedFile[],
  allowlist: unknown,
  truncated: boolean
): boolean {
  try {
    if (
      truncated ||
      !Array.isArray(allowlist) ||
      allowlist.length === 0 ||
      allowlist.length > MAX_BOT_APPROVAL_PATHS ||
      !allowlist.every((g): g is string => typeof g === 'string' && isValidGlob(g)) ||
      files.length === 0
    ) {
      return false;
    }
    const onList = (path: unknown): boolean =>
      typeof path === 'string' && path !== '' && matchesAny(path, allowlist);
    return files.every(
      (f) => onList(f.path) && (f.previousPath === undefined || onList(f.previousPath))
    );
  } catch {
    return false;
  }
}

function withinCap(count: unknown, cap: unknown): boolean {
  return (
    typeof count === 'number' &&
    typeof cap === 'number' &&
    Number.isFinite(count) &&
    Number.isFinite(cap) &&
    count >= 0 &&
    cap > 0 &&
    count <= cap
  );
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Every unmet condition, as its fixed code; an empty list means the bot may approve this head. */
export function botApprovalRefusalConditions(input: BotApprovalInput): BotApprovalCondition[] {
  const failed = new Set<BotApprovalCondition>();
  const require = (condition: BotApprovalCondition, ok: boolean): void => {
    if (!ok) {
      failed.add(condition);
    }
  };
  require('effective-mode-auto', input.effectiveMode === 'auto');
  require('auto-merge-allowed', input.autoMergeAllowed === true);
  require('bot-approval-allowed', input.botApprovalAllowed === true);
  require('repo-bot-approval', input.repoBotApproval === true);
  require('approver-app-configured', input.approverAppConfigured === true);
  require('approver-client-ok', input.approverClientOk === true);
  require('not-draft', input.draft === false);
  require('risk-low', input.riskClass === 'LOW');
  require('auto-eligible', input.autoEligible === true);
  require('no-exclusions', input.exclusionCount === 0);
  require('evidence-satisfied', input.evidenceSatisfied === true);
  require('launcher-resolved', input.launcherResolved === true);
  // One implementation of the branch rules, shared with auto-merge arming.
  for (const refusal of branchRuleRefusals(input.readiness, input.context)) {
    failed.add(refusal.condition);
  }
  // An approval is bound to one commit, but only this rule makes GitHub stop counting it once a
  // later commit is pushed. Anything but a strict `true` refuses.
  require('dismiss-stale-reviews', input.readiness?.dismissStaleReviews === true);
  // An empty context would match an empty required-check name; it is no context at all.
  require('status-required', nonBlank(input.context));
  require('author-differs', nonBlank(input.botLogin) &&
    nonBlank(input.prAuthorLogin) &&
    input.botLogin.trim().toLowerCase() !== input.prAuthorLogin.trim().toLowerCase());
  require('head-sha', nonBlank(input.headSha));
  require('no-human-objection', input.humanObjection === false);
  require('not-suppressed', input.notSuppressed === true);
  require('bot-max-lines', withinCap(input.changedLines, input.maxLines));
  require('bot-max-files', withinCap(input.changedFiles, input.maxFiles));
  require('bot-paths-allowed', input.pathsAllowed === true);
  require('no-net-test-deletion', input.noNetTestDeletion === true);
  require('no-stricter-approver-count', input.requiredApprovers === 1);
  return BOT_APPROVAL_CONDITIONS.filter((c) => failed.has(c));
}

/** Every unmet condition; an empty list means the bot may approve this head. */
export function botApprovalRefusals(input: BotApprovalInput): string[] {
  return botApprovalRefusalConditions(input).map((c) => REFUSAL[c]);
}
