import { describe, expect, it } from 'vitest';
import { buildValidationUserMessage } from './validateContext.js';

describe('buildValidationUserMessage', () => {
  it('uses the structured payload for generic requests', () => {
    const request = {
      connectionId: 'conn-1',
      payload: { title: 'Draft Q3 roadmap', urgency: 'high' },
      workRequestId: 'wr-1',
    };

    const message = buildValidationUserMessage(request);
    const parsed = JSON.parse(message);

    expect(parsed).toEqual({
      payload: { title: 'Draft Q3 roadmap', urgency: 'high' },
    });
  });

  it('falls back to legacy SWE fields when no payload is present', () => {
    const request = {
      description: 'Add a health endpoint',
      externalTicketId: 'JIRA-42',
      repoId: 'repo-1',
      requestPayload: '{ "foo": "bar" }',
      workRequestId: 'wr-2',
    };

    const message = buildValidationUserMessage(request);
    const parsed = JSON.parse(message);

    expect(parsed).toEqual({
      description: 'Add a health endpoint',
      requestPayload: '{ "foo": "bar" }',
      title: 'JIRA-42',
    });
  });
});
