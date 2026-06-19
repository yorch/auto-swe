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
