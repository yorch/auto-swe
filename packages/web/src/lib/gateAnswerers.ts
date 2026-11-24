/**
 * Who can answer a human gate (or control its run), in the one wording the run verdict, the step
 * card and the run controls share.
 *
 * The platform stores no approver or assignee on a gate. Control is worked out per run: a platform
 * admin, a member of a team that owns the run's template, whoever launched the run, or a member of
 * the team that owns its repository (with access to that repository when GitHub access is
 * enforced). The text names the repository team, the launcher and admins and says "include", so it
 * stays short and true without listing the template team; it never names a person and never
 * claims a gate has an approver. The full rule is in docs/hitl-workflows.md (Limitations).
 */

/** Said when no owning team is known; it claims nothing else. */
export const WHO_UNKNOWN = 'The platform does not record who can answer this.';

/** Same, for a verdict that speaks of several gates. */
export const WHO_UNKNOWN_MANY = 'The platform does not record who can answer these.';

type TeamName = string | null | undefined;

/** The distinct, non-empty team names, in first-seen order. */
export function distinctTeamNames(names: TeamName | readonly TeamName[]): string[] {
  const list = Array.isArray(names) ? names : [names];
  return [...new Set(list.map((n) => n?.trim()).filter((n): n is string => !!n))];
}

/** "A", "A or B", "A, B or C". */
function orList(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

/** The people the rule includes, for a run owned by the named team(s). */
export function controllersOf(teamNames: readonly string[]): string {
  return `members of ${orList(teamNames)} (with access to the repository when GitHub access is enforced), the launcher and admins`;
}

/**
 * The general rule for a gate the viewer cannot answer. With several owner teams (different gates
 * name different ones) it names each once; with none it says only that nothing is recorded.
 */
export function whoCanAnswer(
  ownerTeamNames?: TeamName | readonly TeamName[],
  many = false
): string {
  const teams = distinctTeamNames(ownerTeamNames);
  if (teams.length === 0) {
    return many ? WHO_UNKNOWN_MANY : WHO_UNKNOWN;
  }
  return `Answerers include ${controllersOf(teams)}.`;
}

/** Why a run control (cancel, re-run) is unavailable. */
export function runControlWho(ownerTeamName: TeamName, action: string): string {
  const teams = distinctTeamNames(ownerTeamName);
  return `Who can ${action} this run includes ${controllersOf(teams.length ? teams : ['the owning team'])}.`;
}
