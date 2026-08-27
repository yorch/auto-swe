import { describe, expect, it } from 'vitest';
import {
  getOutcomePublisherMetadata,
  isOutcomePublisherType,
  listOutcomePublishers,
  OUTCOME_PUBLISHER_TYPES,
  OutcomePublisherTypeSchema,
} from './outcomePublishers.js';

describe('outcomePublishers', () => {
  it('lists the expected publisher types', () => {
    expect(OUTCOME_PUBLISHER_TYPES).toEqual([
      'openPullRequest',
      'createOrUpdateDocument',
      'updateRecord',
      'sendMessage',
      'createTrackerItem',
      'queueForApproval',
    ]);
  });

  it('validates known publisher types', () => {
    for (const type of OUTCOME_PUBLISHER_TYPES) {
      expect(OutcomePublisherTypeSchema.safeParse(type).success).toBe(true);
      expect(isOutcomePublisherType(type)).toBe(true);
    }
  });

  it('rejects unknown publisher types', () => {
    expect(OutcomePublisherTypeSchema.safeParse('postToTwitter').success).toBe(false);
    expect(isOutcomePublisherType('postToTwitter')).toBe(false);
  });

  it('returns metadata for every publisher', () => {
    const publishers = listOutcomePublishers();
    expect(publishers).toHaveLength(OUTCOME_PUBLISHER_TYPES.length);
    for (const meta of publishers) {
      expect(meta.key).toBeTruthy();
      expect(meta.label).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(getOutcomePublisherMetadata(meta.key)).toBe(meta);
    }
  });

  it('marks openPullRequest as external and not an approval gate', () => {
    const meta = getOutcomePublisherMetadata('openPullRequest');
    expect(meta.isExternal).toBe(true);
    expect(meta.isApprovalGate).toBe(false);
  });

  it('marks queueForApproval as an approval gate and not external', () => {
    const meta = getOutcomePublisherMetadata('queueForApproval');
    expect(meta.isApprovalGate).toBe(true);
    expect(meta.isExternal).toBe(false);
  });
});
