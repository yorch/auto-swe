'use client';

import { usePathname } from 'next/navigation';
import { type RefObject, useState } from 'react';
import { AssistantToggle } from '@/components/assistant/AssistantPanel';
import { HelpButton } from '@/components/help/HelpPanel';
import { CommandPalette, CommandPaletteButton } from '@/components/layout/CommandPalette';
import { SIDEBAR_ID } from '@/components/layout/Sidebar';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { TeamSwitcher } from '@/components/teams/TeamSwitcher';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Breadcrumbs } from '@/components/ui/Breadcrumbs';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { type GatewayStatus, useGatewayStatus } from '@/hooks/useGatewayStatus';
import { pageSection, pageTitle } from '@/lib/navigation';
import { cn } from '@/lib/utils';

const GATEWAY_TONE: Record<GatewayStatus, BadgeTone> = {
  offline: 'danger',
  online: 'success',
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
  focused?: boolean;
}

export function TopBar({ navOpen, onOpenNav, menuButtonRef, focused = false }: TopBarProps) {
  const pathname = usePathname();

  const gatewayStatus = useGatewayStatus();
  const title = pageTitle(pathname);
  const section = pageSection(pathname);
  const [paletteOpen, setPaletteOpen] = useState(false);

  return (
    <header className="sticky top-0 z-20 min-w-0 border-b border-ink-500/70 bg-ink-950">
      <div className="flex h-14 min-w-0 items-center gap-2 px-3 sm:gap-3 md:px-6">
        {/* Menu button — opens the sidebar drawer below md */}
        <IconButton
          aria-controls={SIDEBAR_ID}
          aria-expanded={navOpen}
          aria-label="Open navigation"
          className={cn('-ml-1 text-paper-300', !focused && 'md:hidden')}
          onClick={onOpenNav}
          ref={menuButtonRef}
          size="md"
        >
          <Icon name="menu" size={20} strokeWidth={2} />
        </IconButton>

        {/* Where you are. A breadcrumb, not a heading: the page's own <h1> carries the
          title, so repeating it as a heading made two identical headings per page. */}
        <Breadcrumbs
          className="min-w-0"
          items={[...(section && section !== title ? [{ label: section }] : []), { label: title }]}
        />

        {/* Team switcher: navigation between team spaces. Below sm it moves to its own strip
          under the bar, so it cannot crowd the breadcrumb out. */}
        <div className="max-sm:hidden sm:ml-2">
          <TeamSwitcher />
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right side */}
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <AssistantToggle />
          <CommandPaletteButton onClick={() => setPaletteOpen(true)} />
          {/* The user menu in the drawer carries the same control, so the bar drops it on a phone. */}
          <span className="max-md:hidden">
            <ThemeToggle />
          </span>
          <HelpButton />
          {/* Gateway reachability — driven by a /health probe, never assumed */}
          <Badge
            className="max-sm:hidden"
            dot={gatewayStatus === 'online' ? 'pulse' : true}
            title={`Gateway ${GATEWAY_LABEL[gatewayStatus]}`}
            tone={GATEWAY_TONE[gatewayStatus]}
            variant="text"
          >
            {GATEWAY_LABEL[gatewayStatus]}
          </Badge>
        </div>
      </div>
      <div className="flex min-h-10 items-center gap-2 border-t border-ink-500/50 px-3 py-1 sm:hidden">
        <TeamSwitcher variant="strip" />
      </div>
      <CommandPalette onOpenChange={setPaletteOpen} open={paletteOpen} />
    </header>
  );
}
