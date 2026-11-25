/**
 * An epic launched while the campaign reconciler is on is a `PLANNED` campaign (spec §9). The
 * `/epics` pages and `GET /api/v1/epics` read those campaign rows beside the legacy epics, so a
 * campaign is shown under the status words the epic pages already know.
 */

/** The workflow id prefix of a campaign (`campaign-<campaignId>`). */
export const CAMPAIGN_EPIC_PREFIX = 'campaign-';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The campaign id inside a `campaign-<uuid>` workflow id, or null when it is not one. */
export function campaignIdOfEpicWorkflowId(workflowId: string): string | null {
  if (!workflowId.startsWith(CAMPAIGN_EPIC_PREFIX)) {
    return null;
  }
  const id = workflowId.slice(CAMPAIGN_EPIC_PREFIX.length);
  return UUID_RE.test(id) ? id : null;
}

/** A campaign state as the epic pages' status column reads it. */
export function campaignStatusAsEpic(state: string): string {
  switch (state) {
    case 'STARTING':
    case 'PLANNING':
      return 'PLANNING';
    case 'ACTIVE':
    case 'PAUSED':
    case 'MONITORING':
    case 'RUNNING':
      return 'FANNING_OUT';
    case 'CANCELLING':
    case 'CANCELLED':
      return 'CANCELLED';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'COMPLETED_WITH_FAILURES':
    case 'FAILED_TO_START':
      return 'FAILED';
    default:
      return state;
  }
}
