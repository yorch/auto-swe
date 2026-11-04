'use client';

import { isTerminalWorkflowRunStatus } from '@auto-swe/shared/types/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';

/**
 * Whether the run page is following a running run. While the run is not finished the page polls
 * every few seconds, so it says "Live". Once the reader loads full payloads, the page fetches them
 * once and stops polling, so it says "Paused" and offers the way back; a stale running run must
 * never look current. Renders nothing for a finished run.
 */
export function RunLiveIndicator({
  busy = false,
  fullPayloads,
  onResume,
  status,
}: {
  /** The payload mode is switching; the resume action waits. */
  busy?: boolean;
  fullPayloads: boolean;
  onResume: () => void;
  status: string;
}) {
  if (isTerminalWorkflowRunStatus(status)) {
    return null;
  }
  if (fullPayloads) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2" data-testid="run-live-indicator">
        <Badge dot tone="warning" variant="outline">
          Paused
        </Badge>
        <span className="text-xs text-paper-400">
          Full payloads are loaded, so this page is not refreshing.
        </span>
        <Button
          className="h-[40px] lg:h-7"
          disabled={busy}
          onClick={onResume}
          size="sm"
          variant="ghost"
        >
          Resume live updates
        </Button>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2" data-testid="run-live-indicator">
      <Badge dot tone="info" variant="outline">
        Live
      </Badge>
      <span className="text-xs text-paper-500">Refreshing every few seconds</span>
    </span>
  );
}
