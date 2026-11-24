/**
 * Who can answer a human gate, in the one wording the run verdict and the step card share.
 *
 * The platform stores no approver or assignee on a gate. Control is worked out per run: a platform
 * admin, a member of the team that owns the run's template, whoever launched the run, or a member
 * of the team that owns its repository (with access to that repository when GitHub access is
 * enforced). The wording therefore says what the rule includes, never names a person and never
 * claims a gate has an approver.
 */

/** Said when the owning team is not known; it claims nothing else. */
export const WHO_UNKNOWN = 'The platform does not record who can answer this.';

/** The general rule, naming the owning team when it is known. */
export function whoCanAnswer(ownerTeamName?: string | null): string {
  const team = ownerTeamName?.trim();
  if (!team) {
    return WHO_UNKNOWN;
  }
  return `The platform does not record a named approver. Who can answer is worked out from the run: it includes members of ${team} who have access to the repository, the person who launched the run, and platform admins.`;
}
