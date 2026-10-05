import type { ResolvedIssueTrackerConfig } from './integrations/registry.js';
import { createIssueTrackerProvider } from './integrations/registry.js';
import type { TrackerSyncEvent } from './integrations/types.js';

export type { TrackerSyncEvent };

export async function syncTrackerOnEvent(
  event: TrackerSyncEvent,
  config: ResolvedIssueTrackerConfig,
  log?: { warn: (obj: unknown, msg?: string) => void }
): Promise<void> {
  try {
    const provider = createIssueTrackerProvider(config, { log });
    if (!provider) {
      return;
    }
    await provider.syncOnEvent(event);
  } catch (err) {
    log?.warn({ err, event }, 'Tracker sync failed; continuing');
  }
}

/**
 * Whether a request's ticket id names an issue in the tracker. An id the platform
 * generated (`RunInput.ticketIsSynthetic`: an agent run, a PRD run, a scheduled
 * fire, a launch that named no ticket) cannot exist there, so syncing it would
 * only produce failed calls. Absent a request or an id there is nothing to sync.
 */
export function isTrackerTicket(
  request:
    | { externalTicketId?: string | null; ticketIsSynthetic?: boolean | null }
    | null
    | undefined
): boolean {
  return !!request?.externalTicketId && !request.ticketIsSynthetic;
}
