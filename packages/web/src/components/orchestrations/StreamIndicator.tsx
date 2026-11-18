import { Badge, type BadgeTone } from '@/components/ui/Badge';
import type { OrchestrationStreamState } from '@/hooks/useOrchestrations';

const LABELS: Partial<Record<OrchestrationStreamState, { label: string; tone: BadgeTone }>> = {
  connecting: { label: 'Connecting…', tone: 'neutral' },
  live: { label: 'Live', tone: 'success' },
  polling: { label: 'Updating by polling', tone: 'warning' },
  reconnecting: { label: 'Reconnecting…', tone: 'warning' },
};

/**
 * How the page is receiving updates, in words (colour is only a hint). It is not a live region:
 * a screen reader is not told each time the connection changes, only when the person looks.
 * Shown while the orchestration is live; a finished or paused page says nothing.
 */
export function StreamIndicator({ state }: { state: OrchestrationStreamState }) {
  const entry = LABELS[state];
  if (!entry) {
    return null;
  }
  return (
    <span aria-live="off" data-stream-state={state}>
      <Badge tone={entry.tone} variant="outline">
        {entry.label}
      </Badge>
    </span>
  );
}
