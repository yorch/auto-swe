'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { RefObject } from 'react';
import { SIDEBAR_ID } from '@/components/layout/Sidebar';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Select } from '@/components/ui/Select';
import { useApprovalsCount } from '@/hooks/useApprovals';
import { type GatewayStatus, useGatewayStatus } from '@/hooks/useGatewayStatus';
import { useTeams } from '@/hooks/useTeams';
import { pageSection, pageTitle } from '@/lib/navigation';
import { cn, FOCUS_RING } from '@/lib/utils';
import { useTeamStore } from '@/stores/teamStore';

const GATEWAY_TONE: Record<GatewayStatus, BadgeTone> = {
  offline: 'brick',
  online: 'moss',
  pending: 'neutral',
  unknown: 'neutral',
};

const GATEWAY_LABEL: Record<GatewayStatus, string> = {
  offline: 'offline',
  online: 'online',
  pending: 'checking',
  unknown: 'status unknown',
};

interface TopBarProps {
  navOpen: boolean;
  onOpenNav: () => void;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
}

export function TopBar({ navOpen, onOpenNav, menuButtonRef }: TopBarProps) {
  const pathname = usePathname();
  const { selectedTeamId, setSelectedTeamId } = useTeamStore();
  const { data: teams } = useTeams();

  const inboxCount = useApprovalsCount();
  const gatewayStatus = useGatewayStatus();
  const title = pageTitle(pathname);
  const section = pageSection(pathname);

  return (
    <header className="sticky top-0 z-20 flex h-[60px] min-w-0 items-center gap-2 border-b border-ink-400 bg-ink-950/70 px-3 backdrop-blur-md sm:gap-[14px] md:px-[26px]">
      {/* Menu button — opens the sidebar drawer below md */}
      <button
        aria-controls={SIDEBAR_ID}
        aria-expanded={navOpen}
        aria-label="Open navigation"
        className={cn(
          '-ml-1 shrink-0 rounded-md p-2 text-paper-300 hover:text-paper-100 md:hidden',
          FOCUS_RING
        )}
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

      {/* Where you are. A breadcrumb, not a heading: the page's own <h1> carries the
          title, so repeating it as a heading made two identical headings per page. */}
      <nav aria-label="Breadcrumb" className="min-w-0 truncate text-[13px] text-paper-400">
        {section && section !== title && (
          <>
            <span>{section}</span>
            <span aria-hidden="true" className="px-1.5 text-paper-600">
              ›
            </span>
          </>
        )}
        <span aria-current="page" className="font-semibold text-paper-100">
          {title}
        </span>
      </nav>

      {/* Team context selector */}
      <Select
        appearance="pill"
        aria-label="Select team"
        className="shrink sm:ml-2"
        onChange={(v) => setSelectedTeamId(v || null)}
        options={[
          { label: 'all teams', value: '' },
          ...(teams ?? []).map((t) => ({ label: t.name, value: t.id })),
        ]}
        prefix="team:"
        value={selectedTeamId ?? ''}
      />

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
        {/* Gateway reachability — driven by a /health probe, never assumed */}
        <Badge
          className="tracking-[0.18em] max-sm:hidden"
          dot={gatewayStatus === 'online' ? 'pulse' : true}
          tone={GATEWAY_TONE[gatewayStatus]}
          uppercase
          variant="text"
        >
          {GATEWAY_LABEL[gatewayStatus]}
        </Badge>
      </div>
    </header>
  );
}
