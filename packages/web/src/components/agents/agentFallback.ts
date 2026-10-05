import type { AgentRow, AgentScope } from '@/hooks/useAgentLibrary';

/** Most specific first: what a run resolves through, falling back down the list. */
const SCOPE_ORDER: AgentScope[] = [
  'WORKFLOW_TEMPLATE',
  'CHANNEL',
  'TEAM',
  'ORGANIZATION',
  'GLOBAL',
];

/**
 * The broader scopes that still hold an active row for this key once `row` is gone, from the
 * rows the caller has loaded. An organization row only counts when it is the row's own one.
 */
export function broaderFallbacks(row: AgentRow, all: AgentRow[]): AgentScope[] {
  const broader = SCOPE_ORDER.slice(SCOPE_ORDER.indexOf(row.scope) + 1);
  return broader.filter((scope) =>
    all.some(
      (a) =>
        a.key === row.key &&
        a.isActive &&
        a.scope === scope &&
        (scope !== 'ORGANIZATION' || !row.orgId || !a.orgId || a.orgId === row.orgId)
    )
  );
}
