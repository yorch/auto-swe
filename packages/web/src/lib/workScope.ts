/**
 * The scope control on the work lists (tickets, pull requests). It filters what the list shows,
 * so its labels name the work, not the request record: "Mine" is the caller's own work and
 * "My team" the work of the caller's team.
 */
export const WORK_SCOPE_OPTIONS: { label: string; value: 'MINE' | 'TEAM' }[] = [
  { label: 'Mine', value: 'MINE' },
  { label: 'My team', value: 'TEAM' },
];
