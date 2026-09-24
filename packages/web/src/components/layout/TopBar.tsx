'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { RefObject } from 'react';
import { SIDEBAR_ID } from '@/components/layout/Sidebar';
import { Select } from '@/components/ui/Select';
import { useApprovalsCount } from '@/hooks/useApprovals';
import { useTeams } from '@/hooks/useTeams';
import { pageTitle } from '@/lib/navigation';
import { useAuthStore } from '@/stores/authStore';
import { useTeamStore } from '@/stores/teamStore';

interface TopBarProps {
  navOpen: boolean;
  onOpenNav: () => void;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
}

export function TopBar({ navOpen, onOpenNav, menuButtonRef }: TopBarProps) {
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
      className="flex min-w-0 items-center gap-2 px-3 sm:gap-[14px] md:px-[26px]"
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
      {/* Menu button — opens the sidebar drawer below md */}
      <button
        aria-controls={SIDEBAR_ID}
        aria-expanded={navOpen}
        aria-label="Open navigation"
        className="-ml-1 shrink-0 rounded-md p-2 text-paper-300 hover:text-paper-100 md:hidden"
        onClick={onOpenNav}
        ref={menuButtonRef}
        type="button"
      >
        <svg
          aria-hidden="true"
          fill="none"
          height={20}
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth={2}
          viewBox="0 0 24 24"
          width={20}
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Page title */}
      <h2
        className="min-w-0 truncate"
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
        className="relative flex min-w-0 shrink cursor-pointer items-center gap-[6px] sm:ml-2"
        htmlFor="topbar-team-select"
      >
        <span
          className="min-w-0"
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
          <span className="max-sm:hidden">team:</span>
          <span
            className="max-w-[9rem] truncate"
            style={{ color: 'var(--color-ember-400)', fontWeight: 600 }}
          >
            {teamLabel}
          </span>
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
          className="shrink-0 max-sm:hidden"
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
      <div className="flex shrink-0 items-center gap-3">
        {/* Online dot */}
        <div className="flex items-center gap-2 max-sm:hidden">
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
          className="max-sm:hidden"
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
