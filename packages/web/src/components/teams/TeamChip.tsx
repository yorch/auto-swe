'use client';

import { Icon } from '@/components/ui/Icon';
import { cn, FOCUS_RING } from '@/lib/utils';

/**
 * The active team filter of a global page, with the way out. A global page lists every team's
 * work until `?team=` narrows it; the chip says so and removing it drops the parameter. Renders
 * nothing without a team, so a page can place it unconditionally.
 */
export function TeamChip({
  className,
  onRemove,
  team,
}: {
  team: { name: string } | null | undefined;
  onRemove: () => void;
  className?: string;
}) {
  if (!team) {
    return null;
  }
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border border-accent-400/30 bg-accent-400/10 py-0.5 pr-1 pl-2.5 text-xs text-accent-300',
        className
      )}
      data-testid="team-chip"
    >
      <span className="truncate">
        <span className="text-paper-400">Team: </span>
        {team.name}
      </span>
      <button
        aria-label={`Remove the ${team.name} team filter`}
        className={cn(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-paper-300 pointer-coarse:h-8 pointer-coarse:w-8 hover:bg-accent-400/20 hover:text-paper-50',
          FOCUS_RING
        )}
        onClick={onRemove}
        type="button"
      >
        <Icon name="close" size={12} />
      </button>
    </span>
  );
}
