import type {
  ApprovalState,
  Classification,
  CommitStatus,
  ExcludedIdentities,
  PrEvaluationMode,
  PrReview,
} from './types.js';

const MAX_DESCRIPTION = 140;

/**
 * Distinct people whose latest review is an approval of this exact commit.
 * Only the latest review per login counts (a later comment or change request
 * withdraws an approval); the author never counts; a review of an older commit
 * is stale; accounts ending in `[bot]` and any login in `ignoreLogins`
 * (lowercased) never count. When `eligibleLogins` (lowercased) is given, only a
 * login in it can count: the caller passes the logins it verified to hold write
 * access, so an approval from anyone else does not. `excludedIdentities` names people whose
 * approval never counts (the run's launcher): a review is theirs when its author's id is in `ids`
 * (stable across a rename, so the primary check) or its lower-cased login is in `logins`. Reviews are expected oldest first, as GitHub lists
 * them. One human with two logins cannot be detected here. `required` is
 * floored at 1, and a blank `headSha` is never satisfied.
 */
export function approvalState(
  reviews: readonly PrReview[],
  prAuthor: string,
  required: number,
  headSha: string,
  ignoreLogins: readonly string[] = [],
  eligibleLogins?: ReadonlySet<string>,
  excludedIdentities?: ExcludedIdentities
): ApprovalState {
  const needed = Number.isFinite(required) ? Math.max(1, Math.trunc(required)) : 1;
  if (typeof headSha !== 'string' || headSha.trim() === '') {
    return { approvers: [], required: needed, satisfied: false };
  }
  const author = prAuthor.toLowerCase();
  const ignored = new Set(ignoreLogins.map((login) => login.toLowerCase()));
  const latest = new Map<string, PrReview>();
  for (const review of reviews) {
    latest.set(review.login.toLowerCase(), review);
  }
  const approvers: string[] = [];
  for (const [login, review] of latest) {
    if (
      login !== author &&
      !login.endsWith('[bot]') &&
      !ignored.has(login) &&
      (eligibleLogins === undefined || eligibleLogins.has(login)) &&
      !isExcluded(review, login, excludedIdentities) &&
      review.state === 'APPROVED' &&
      review.commitId === headSha
    ) {
      approvers.push(review.login);
    }
  }
  return { approvers, required: needed, satisfied: approvers.length >= needed };
}

function isExcluded(
  review: PrReview,
  login: string,
  excluded: ExcludedIdentities | undefined
): boolean {
  if (!excluded) {
    return false;
  }
  return (
    (typeof review.userId === 'string' &&
      review.userId !== '' &&
      excluded.ids.has(review.userId)) ||
    excluded.logins.has(login)
  );
}

function clip(text: string): string {
  return text.length <= MAX_DESCRIPTION ? text : `${text.slice(0, MAX_DESCRIPTION - 3)}...`;
}

/** The commit status to publish, or null when the repository has evaluation off. */
export function statusFor(
  classification: Classification,
  approval: ApprovalState,
  mode: PrEvaluationMode
): CommitStatus | null {
  if (mode === 'off') {
    return null;
  }
  // Any mode that is not `advisory` (an unrecognised string included) is held to the strict
  // rules below; only `enforce` says so in the description.
  const label = `${mode === 'enforce' ? 'enforce: ' : ''}${classification.riskClass} risk`;
  const progress = `${approval.approvers.length}/${approval.required} approvals`;
  if (mode === 'advisory') {
    return { description: clip(`advisory: ${label}, ${progress}`), state: 'success' };
  }
  if (classification.reasons.some((r) => r.code === 'evaluation-error')) {
    return {
      description: clip(`${label}: evaluation failed, treated as high risk`),
      state: 'failure',
    };
  }
  return approval.satisfied
    ? { description: clip(`${label}: ${progress}`), state: 'success' }
    : { description: clip(`${label}: waiting for ${progress}`), state: 'pending' };
}
