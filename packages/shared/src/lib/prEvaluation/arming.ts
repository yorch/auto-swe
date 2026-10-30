/**
 * Whether auto-merge may be armed on a pull request, as a pure function of what GitHub enforces.
 * The worker decides with it, and the gateway decides with it before it accepts `auto` mode.
 *
 * Arming is allowed only when GitHub itself will hold the merge until our status is green: the
 * repository allows auto-merge, the status context is a required check, that requirement names a
 * GitHub App (a token that is not an App can post any status under any name, so an unpinned
 * requirement can be satisfied by anyone with push access), and a human or the approval count
 * stands behind it. The pinning is to the platform's own App: a requirement pinned to another App
 * (GitHub Actions, say) is satisfied by any workflow with `statuses: write`. `'unknown'` is never read as permission.
 */

/** The part of the host's branch rules arming reads. Missing fields (an older row) are unknown. */
export interface BranchRulesLike {
  allowsAutoMerge?: boolean | 'unknown';
  /** True only when every review rule of the base branch dismisses an approval on a new push. */
  dismissStaleReviews?: boolean | 'unknown';
  requiresReviews?: boolean | 'unknown';
  requiredReviewCount?: number | 'unknown';
  requiredStatusContexts?: string[] | 'unknown';
  requiredStatusPinnedToApp?: boolean | 'unknown';
}

export interface AutoArmingInput {
  /** The branch rules as last read; null when they could not be read at all. */
  readiness: BranchRulesLike | null | undefined;
  /** The status context the evaluator publishes. */
  context: string;
  /** Whether the approval count this evaluation requires is already met on the head. */
  approvalSatisfied: boolean;
  /** Whether the commit status for this evaluation was accepted by the host. */
  statusPublished: boolean;
  draft: boolean;
  /**
   * Whether everyone who launched a run of this work, and whoever requested it, is matched to a
   * linked GitHub account by numeric id on the repository's host, so their approval was excluded
   * from the count. Anything other than `true` refuses: an approval that cannot be told from
   * theirs must not stand behind an unattended merge.
   */
  launcherResolved: boolean;
}

/** The branch-rule conditions that make the platform status binding; each is a refusal below. */
export type BranchRuleCondition = 'allows-auto-merge' | 'status-required' | 'status-pinned';

export interface BranchRuleRefusal {
  condition: BranchRuleCondition;
  /** The operator-facing explanation of the refusal. */
  reason: string;
}

/**
 * The one implementation of "GitHub itself will hold a merge until our status is green": the
 * repository allows auto-merge, the status context is a required check, and that requirement is
 * pinned to the platform's own App. Arming and bot approval both call it, so they cannot disagree
 * about what counts. Anything but a strict `true` (or the context listed) refuses.
 */
export function branchRuleRefusals(
  readiness: BranchRulesLike | null | undefined,
  context: string
): BranchRuleRefusal[] {
  const refusals: BranchRuleRefusal[] = [];
  if (readiness?.allowsAutoMerge !== true) {
    refusals.push({
      condition: 'allows-auto-merge',
      reason:
        readiness?.allowsAutoMerge === false
          ? 'the repository does not allow auto-merge'
          : 'whether the repository allows auto-merge is unknown',
    });
  }
  const contexts = readiness?.requiredStatusContexts;
  if (!Array.isArray(contexts)) {
    refusals.push({
      condition: 'status-required',
      reason: 'the required status checks of the base branch are unknown',
    });
  } else if (!contexts.includes(context)) {
    refusals.push({
      condition: 'status-required',
      reason: `the status "${context}" is not a required check on the base branch`,
    });
  }
  const pinned = readiness?.requiredStatusPinnedToApp;
  if (pinned !== true) {
    refusals.push({
      condition: 'status-pinned',
      reason:
        pinned === false
          ? `the required status "${context}" is not pinned to the platform's own GitHub App, so another App or token can satisfy it; pin it to the platform's GitHub App`
          : `whether the required status "${context}" is pinned to the platform's own GitHub App is unknown; auto mode needs a GitHub App credential (a personal access token cannot be pinned; configure a GitHub App) and the requirement pinned to it`,
    });
  }
  return refusals;
}

/** Every reason arming is not allowed; an empty list means it is allowed. */
export function autoArmingRefusals(input: AutoArmingInput): string[] {
  const { readiness, context } = input;
  const reasons: string[] = branchRuleRefusals(readiness, context).map((r) => r.reason);
  const requiresReviews = readiness?.requiresReviews;
  const reviewCount = readiness?.requiredReviewCount;
  const reviewsRequired =
    requiresReviews === true && typeof reviewCount === 'number' && reviewCount >= 1;
  if (!reviewsRequired && !input.approvalSatisfied) {
    reasons.push(
      requiresReviews === true
        ? 'the branch does not provably require at least one approving review and the approvals this change needs are not yet given'
        : 'the branch does not require reviews and the approvals this change needs are not yet given'
    );
  }
  if (!input.statusPublished) {
    reasons.push('the commit status was not published');
  }
  if (input.draft) {
    reasons.push('draft');
  }
  if (input.launcherResolved !== true) {
    reasons.push(
      "someone who launched or requested this work is not matched to a linked GitHub account on the repository's host, so their own approval cannot be told apart"
    );
  }
  return reasons;
}
