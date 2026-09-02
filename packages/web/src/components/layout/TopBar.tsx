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
    ['/connections', 'Connections'],
    ['/govern/security', 'Security'],
    ['/govern/scanner', 'Scanner'],
    ['/govern/evals', 'Evals'],
    ['/govern/schedules', 'Schedules'],
    ['/govern/budget-alerts', 'Budget alerts'],
    ['/govern/budgets', 'Budgets'],
    ['/govern/teams', 'Teams'],
    ['/govern/organizations', 'Organizations'],
    ['/govern/users', 'Users'],
    ['/govern/api-tokens', 'API tokens'],
    ['/govern/lessons', 'Lessons'],
    ['/govern/analytics', 'Analytics'],
    ['/govern/baselines', 'Error baselines'],
    ['/govern/sessions', 'Sessions'],
    ['/govern/slack-channels', 'Slack channels'],
    ['/govern/workflow-defaults', 'Workflow defaults'],
    ['/govern/platform-settings', 'Platform settings'],
    ['/govern', 'Govern'],
    ['/studio/agents', 'Agents'],
    ['/studio/skills', 'Skills'],
    ['/studio/mcp', 'MCP'],
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
    <header
      className="flex items-center gap-[14px] px-[26px]"
      style={{
        backdropFilter: 'blur(12px)',
        background: 'rgba(10, 12, 18, 0.72)',
        borderBottom: '1px solid var(--color-ink-400)',
        height: 60,
        position: 'sticky',
        top: 0,
        zIndex: 20,
      }}
    >
      {/* Page title */}
      <h2
        style={{
          color: 'var(--color-paper-100)',
          fontSize: 17,
          fontWeight: 650,
          letterSpacing: '-0.02em',
          margin: 0,
        }}
      >
        {title}
      </h2>

      {/* Team context selector */}
      <label
        className="relative flex cursor-pointer items-center gap-[6px]"
        htmlFor="topbar-team-select"
        style={{ marginLeft: 8 }}
      >
        <span
          style={{
            alignItems: 'center',
            background: 'var(--color-ink-700)',
            border: '1px solid var(--color-ink-400)',
            borderRadius: 8,
            color: 'var(--color-paper-400)',
            cursor: 'pointer',
            display: 'inline-flex',
            fontSize: 12.5,
            gap: 6,
            padding: '5px 10px',
          }}
        >
          team:{' '}
          <span style={{ color: 'var(--color-ember-400)', fontWeight: 600 }}>{teamLabel}</span>
          <span style={{ color: 'var(--color-paper-500)', fontSize: 10 }}>▾</span>
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
          href="/govern/approvals"
          style={{
            alignItems: 'center',
            background: 'rgba(246, 181, 69, 0.1)',
            border: '1px solid rgba(246, 181, 69, 0.4)',
            borderRadius: 8,
            color: 'var(--color-amber-400)',
            display: 'inline-flex',
            fontSize: 12.5,
            fontWeight: 600,
            gap: 6,
            padding: '5px 10px',
            textDecoration: 'none',
          }}
        >
          <span
            style={{
              background: 'var(--color-amber-400)',
              borderRadius: '50%',
              display: 'inline-block',
              height: 7,
              width: 7,
            }}
          />
          {inboxCount} pending
        </Link>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Right side */}
      <div className="flex items-center gap-3">
        {/* Online dot */}
        <div className="flex items-center gap-2">
          <span
            className="pulse-dot"
            style={{
              background: 'var(--color-moss-400)',
              borderRadius: '50%',
              display: 'inline-block',
              height: 6,
              width: 6,
            }}
          />
          <span
            style={{
              color: 'var(--color-paper-500)',
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
            }}
          >
            online
          </span>
        </div>

        <span
          style={{
            background: 'var(--color-ink-400)',
            display: 'inline-block',
            height: 14,
            width: 1,
          }}
        />

        <button
          onClick={handleLogout}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--color-paper-500)',
            cursor: 'pointer',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.14em',
            padding: 0,
            textTransform: 'uppercase',
          }}
          type="button"
        >
          Logout ↗
        </button>
      </div>
    </header>
  );
}
