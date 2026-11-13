import { campaignTextProblem } from '@auto-swe/shared/lib/campaignOutcome';
import {
  CAMPAIGN_CHILD_INPUT_BUDGET_BYTES,
  CAMPAIGN_DESCRIPTION_MAX_LENGTH,
} from '@auto-swe/shared/types/workflow';
import { describe, expect, it } from 'vitest';
import { campaignChildArgs } from './campaignRequest.js';

/** The registry ceiling of `workflow.campaignMaxTargets`. */
const MAX_TARGETS = 200;

const uuid = (i: number) => `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`;

/** The bytes Temporal's default (JSON) payload converter writes for a child's start input. */
const startInputBytes = (args: unknown) => Buffer.byteLength(JSON.stringify([args]), 'utf8');

function worstCaseInput(description: string) {
  return {
    campaignWorkflowId: `campaign-${uuid(0)}`,
    childPayload: {
      budget: 'STANDARD',
      // The longest values the template's input schema admits.
      packageName: `@${'a'.repeat(254)}`,
      recipe: 'npm-dependency@1',
      targetVersion: `1.0.0-${'z'.repeat(122)}`,
    },
    description,
    externalTicketId: 'CAMPAIGN-0123456789ab',
    launchedById: uuid(1),
    templateId: uuid(2),
    templateVersion: 2_147_483_647,
    workRequestId: uuid(3),
  };
}

describe('campaignChildArgs', () => {
  it('carries the brief once and the child payload, never a copy of the launch request', () => {
    const args = campaignChildArgs(worstCaseInput('Raise lodash'), { connectionId: uuid(9) });
    expect(args.request.description).toBe('Raise lodash');
    expect(args.request.payload).toEqual({
      budget: 'STANDARD',
      connectionId: uuid(9),
      packageName: `@${'a'.repeat(254)}`,
      recipe: 'npm-dependency@1',
      targetVersion: `1.0.0-${'z'.repeat(122)}`,
    });
    expect(JSON.parse(args.request.requestPayload)).toEqual(args.request.payload);
    expect(args.request.requestPayload).not.toContain('Raise lodash');
  });

  // The costliest characters a brief that passes the launch check can be made of: a BMP character
  // outside ASCII (3 bytes of UTF-8), a JSON-escaped quote or backslash, an escaped line break, and
  // a well-formed surrogate pair (4 bytes for 2 code units).
  it.each([
    ['CJK', '一'],
    ['quote', '"'],
    ['backslash', '\\'],
    ['newline', '\n'],
    ['surrogate pair', '😀'],
  ])(
    'keeps every child start input under the budget for a %s brief at the maximum length',
    (_label, ch) => {
      const description = ch.repeat(Math.floor(CAMPAIGN_DESCRIPTION_MAX_LENGTH / ch.length));
      expect(description.length).toBeLessThanOrEqual(CAMPAIGN_DESCRIPTION_MAX_LENGTH);
      expect(campaignTextProblem(description)).toBeNull();
      const input = worstCaseInput(description);
      let total = 0;
      for (let i = 0; i < MAX_TARGETS; i++) {
        const bytes = startInputBytes(campaignChildArgs(input, { connectionId: uuid(100 + i) }));
        expect(bytes).toBeLessThanOrEqual(CAMPAIGN_CHILD_INPUT_BUDGET_BYTES);
        total += bytes;
      }
      // Every child start of a campaign at the target ceiling, under Temporal's 10 MiB warning.
      expect(total).toBeLessThan(10 * 1024 * 1024);
    }
  );

  it('the characters that would cost more are refused at launch', () => {
    expect(campaignTextProblem('a\u0001b')).toMatch(/control characters/);
    expect(campaignTextProblem('a\u007fb')).toMatch(/control characters/);
    expect(campaignTextProblem('a\u0085b')).toMatch(/control characters/);
    expect(campaignTextProblem('a\ud800b')).toMatch(/lone surrogates/);
    expect(campaignTextProblem('a\udc00')).toMatch(/lone surrogates/);
    expect(campaignTextProblem('tab\tline\r\nend 😀')).toBeNull();
  });
});
