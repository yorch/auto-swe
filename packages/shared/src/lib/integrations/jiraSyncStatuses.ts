/**
 * The statuses the platform's own Jira sync asks for (`syncOnEvent` in `providers/jira.ts`): a
 * run's start, its pull request and its completion move the ticket to these. The status-change
 * poller (docs/automations.md §3.2) reads them to tell a transition the platform made from one a
 * person made.
 */
export const JIRA_SYNC_STATUSES = {
  completed: 'Done',
  prOpened: 'In Review',
  started: 'In Progress',
} as const;

/** The same names, lower-cased, as the poller compares statuses. */
export const JIRA_SYNC_STATUS_KEYS: readonly string[] = Object.values(JIRA_SYNC_STATUSES).map((s) =>
  s.toLowerCase()
);
