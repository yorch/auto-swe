'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Select } from '@/components/ui/Select';
import { useApprovalsCount } from '@/hooks/useApprovals';
import { useTeams } from '@/hooks/useTeams';
import { useAuthStore } from '@/stores/authStore';
import { useTeamStore } from '@/stores/teamStore';

// Derive a readable page title from the pathname
function pageTitle(pathname: string): string {
  const prefixes: [string, string][] = [
    ['/', 'Dashboard'],
    ['/runs/', 'Run'],
    ['/runs', 'Runs'],
    ['/govern/approvals', 'Approvals'],
    ['/workflows/library', 'Workflow library'],
    ['/workflows', 'Request queue'],
    ['/epics', 'Epics'],
    ['/connections', 'Connections'],
    ['/govern/security', 'Security'],
    ['/govern/scanner', 'Scanner'],
    ['/govern/policies', 'Autonomy policies'],
    ['/govern/evals', 'Evals'],
    ['/govern/schedules', 'Schedules'],
    ['/govern/budget-alerts', 'Budget alerts'],
    ['/govern/teams', 'Teams'],
    ['/govern/organizations', 'Organizations'],
    ['/govern/users', 'Users'],
    ['/govern/api-tokens', 'API tokens'],
    ['/govern/lessons', 'Lessons'],
    ['/govern/analytics', 'Analytics'],
    ['/govern/usage', 'LLM usage'],
    ['/govern/baselines', 'Error baselines'],
    ['/govern/sessions', 'Sessions'],
    ['/govern/slack-channels', 'Slack channels'],
    ['/govern/workflow-defaults', 'Workflow defaults'],
    ['/govern/platform-settings', 'Platform settings'],
    ['/govern/config-grants', 'Config grants'],
    ['/govern/audit', 'Audit log'],
    ['/govern', 'Govern'],
    ['/studio/agents', 'Agents'],
    ['/studio/skills', 'Skills'],
    ['/studio/mcp', 'MCP'],
    ['/studio/github-installations', 'GitHub installations'],
    ['/studio/integrations', 'Integrations'],
    ['/studio/models', 'Model config'],
    ['/studio/bundles', 'Bundles'],
    ['/studio', 'Studio'],
    ['/settings', 'Settings'],
    ['/docs', 'Docs'],
  ];
  for (const [prefix, title] of prefixes) {
    if (prefix === '/' ? pathname === '/' : pathname.startsWith(prefix)) {
      return title;
    }
  }
  return 'auto·swe';
}

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const logout = useAuthStore((s) => s.logout);
  const { selectedTeamId, setSelectedTeamId } = useTeamStore();
  const { data: teams } = useTeams();

  const handleLogout = async () => {
    // logout() clears the gateway session and local cookies; navigating before
    // it settles can land on /login with the old session still valid.
    await logout();
    router.push('/login');
  };

  const teamLabel = teams?.find((t) => t.id === selectedTeamId)?.name ?? 'all teams';
  const inboxCount = useApprovalsCount();
  const title = pageTitle(pathname);

  return (
    <header className="sticky top-0 z-20 flex h-[60px] items-center gap-[14px] border-b border-ink-400 bg-ink-950/70 px-[26px] backdrop-blur-md">
      {/* Page title */}
      <h2 className="m-0 text-[17px] font-[650] tracking-[-0.02em] text-paper-100">{title}</h2>

      {/* Team context selector */}
      <label
        className="relative ml-2 flex cursor-pointer items-center gap-[6px] rounded-[8px] focus-within:ring-2 focus-within:ring-ember-400"
        htmlFor="topbar-team-select"
      >
        <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-[8px] border border-ink-400 bg-ink-700 px-2.5 py-[5px] text-[12.5px] text-paper-400">
          team: <span className="font-semibold text-ember-400">{teamLabel}</span>
          <span className="text-[10px] text-paper-500">▾</span>
        </span>
        <Select
          aria-label="Select team"
          className="absolute inset-0 cursor-pointer opacity-0"
          id="topbar-team-select"
          onChange={(e) => setSelectedTeamId(e.target.value || null)}
          value={selectedTeamId ?? ''}
        >
          <option value="">all teams</option>
          {(teams ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </label>

      {/* Inbox badge */}
      {inboxCount > 0 && (
        <Link
          className="inline-flex items-center gap-1.5 rounded-[8px] border border-amber-400/40 bg-amber-400/10 px-2.5 py-[5px] text-[12.5px] font-semibold text-amber-400 no-underline"
          href="/govern/approvals"
        >
          <span className="inline-block h-[7px] w-[7px] rounded-full bg-amber-400" />
          {inboxCount} pending
        </Link>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right side */}
      <div className="flex items-center gap-3">
        {/* Online dot */}
        <div className="flex items-center gap-2">
          <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-moss-400" />
          <span className="label-mono">online</span>
        </div>

        <span className="inline-block h-3.5 w-px bg-ink-400" />

        <button
          className="cursor-pointer border-none bg-transparent p-0 font-mono text-[10px] uppercase tracking-[0.14em] text-paper-500 hover:text-paper-200"
          onClick={handleLogout}
          type="button"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
