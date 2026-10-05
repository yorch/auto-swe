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
 * rows the caller has loaded. A team row only counts when it is the row's own team, and an
 * organization row only when it is the row's own organization. A row's organization is read
 * from the row, else from any loaded row of the same team; when it cannot be known, no
 * organization fallback is claimed.
 */
export function broaderFallbacks(row: AgentRow, all: AgentRow[]): AgentScope[] {
  const broader = SCOPE_ORDER.slice(SCOPE_ORDER.indexOf(row.scope) + 1);
  const ownOrgId =
    row.orgId ?? (row.teamId ? all.find((a) => a.teamId === row.teamId && a.orgId)?.orgId : null);
  return broader.filter((scope) =>
    all.some((a) => {
      if (a.key !== row.key || !a.isActive || a.scope !== scope) {
        return false;
      }
      if (scope === 'TEAM') {
        return !!row.teamId && a.teamId === row.teamId;
      }
      if (scope === 'ORGANIZATION') {
        return !!ownOrgId && a.orgId === ownOrgId;
      }
      return true;
    })
  );
}
