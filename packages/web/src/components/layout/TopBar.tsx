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
    <header className="sticky top-0 z-20 flex h-[60px] min-w-0 items-center gap-2 border-b border-ink-400 bg-ink-950/70 px-3 backdrop-blur-md sm:gap-[14px] md:px-[26px]">
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
      <h2 className="m-0 min-w-0 truncate text-[17px] font-[650] tracking-[-0.02em] text-paper-100">
        {title}
      </h2>

      {/* Team context selector */}
      <label
        className="relative flex min-w-0 shrink cursor-pointer items-center gap-[6px] rounded-[8px] sm:ml-2 focus-within:ring-2 focus-within:ring-ember-400"
        htmlFor="topbar-team-select"
      >
        <span className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-[8px] border border-ink-400 bg-ink-700 px-2.5 py-[5px] text-[12.5px] text-paper-400">
          <span className="max-sm:hidden">team:</span>
          <span className="max-w-[9rem] truncate font-semibold text-ember-400">{teamLabel}</span>
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
          className="inline-flex shrink-0 items-center gap-1.5 rounded-[8px] border border-amber-400/40 bg-amber-400/10 px-2.5 py-[5px] text-[12.5px] font-semibold text-amber-400 no-underline max-sm:hidden"
          href="/govern/approvals"
        >
          <span className="inline-block h-[7px] w-[7px] rounded-full bg-amber-400" />
          {inboxCount} pending
        </Link>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Right side */}
      <div className="flex shrink-0 items-center gap-3">
        {/* Online dot */}
        <div className="flex items-center gap-2 max-sm:hidden">
          <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full bg-moss-400" />
          <span className="label-mono">online</span>
        </div>

        <span className="inline-block h-3.5 w-px bg-ink-400 max-sm:hidden" />

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
