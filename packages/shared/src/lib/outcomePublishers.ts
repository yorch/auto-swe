import { z } from 'zod';

/**
 * Registry of supported outcome publishers.
 *
 * A publisher materializes a validated workflow outcome into the world. The
 * platform's autonomy policy decides whether a publisher runs immediately or
 * requires human approval first.
 */

export const OUTCOME_PUBLISHER_TYPES = [
  'openPullRequest',
  'createOrUpdateDocument',
  'updateRecord',
  'sendMessage',
  'createTrackerItem',
  'queueForApproval',
] as const;

export type OutcomePublisherType = (typeof OUTCOME_PUBLISHER_TYPES)[number];

export interface OutcomePublisherMetadata {
  key: OutcomePublisherType;
  label: string;
  description: string;
  /** Whether the action is visible outside the team (and therefore approval-gated by default). */
  isExternal: boolean;
  /** Whether the publisher is itself an explicit human-approval gate rather than a side effect. */
  isApprovalGate: boolean;
}

const METADATA: Record<OutcomePublisherType, OutcomePublisherMetadata> = {
  createOrUpdateDocument: {
    description: 'Create or update a document in a connected workspace.',
    isApprovalGate: false,
    isExternal: true,
    key: 'createOrUpdateDocument',
    label: 'Create or update document',
  },
  createTrackerItem: {
    description: 'Create a work item in a connected issue tracker.',
    isApprovalGate: false,
    isExternal: true,
    key: 'createTrackerItem',
    label: 'Create tracker item',
  },
  openPullRequest: {
    description: 'Open or update a pull request in a connected git repository.',
    isApprovalGate: false,
    isExternal: true,
    key: 'openPullRequest',
    label: 'Open pull request',
  },
  queueForApproval: {
    description: 'Pause the run and present the outcome for explicit human approval.',
    isApprovalGate: true,
    isExternal: false,
    key: 'queueForApproval',
    label: 'Queue for approval',
  },
  sendMessage: {
    description: 'Send a Slack message, email, or other notification.',
    isApprovalGate: false,
    isExternal: true,
    key: 'sendMessage',
    label: 'Send message',
  },
  updateRecord: {
    description: 'Update a record in a connected CRM, ticket, or HR system.',
    isApprovalGate: false,
    isExternal: true,
    key: 'updateRecord',
    label: 'Update record',
  },
};

export const OutcomePublisherTypeSchema = z.enum(OUTCOME_PUBLISHER_TYPES);

export function isOutcomePublisherType(value: unknown): value is OutcomePublisherType {
  return (
    typeof value === 'string' && (OUTCOME_PUBLISHER_TYPES as readonly string[]).includes(value)
  );
}

export function getOutcomePublisherMetadata(type: OutcomePublisherType): OutcomePublisherMetadata {
  return METADATA[type];
}

export function listOutcomePublishers(): OutcomePublisherMetadata[] {
  return OUTCOME_PUBLISHER_TYPES.map((key) => METADATA[key]);
}
