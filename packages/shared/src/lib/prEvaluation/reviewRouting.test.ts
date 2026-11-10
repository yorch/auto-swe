import { describe, expect, it } from 'vitest';
import {
  decideNeedsHuman,
  mergeReviewRouting,
  parseReviewRoutingOverride,
  type ReviewRouting,
  type RoutingEvaluation,
  type RoutingInput,
} from './reviewRouting.js';

const POLICY: ReviewRouting = {
  humanAboveLines: 0,
  humanMinRisk: 'LOW',
  humanPaths: [],
  quickReviewMaxLines: 100,
  skipWhenBotApproved: true,
};

const evaluation = (over: Partial<RoutingEvaluation> = {}): RoutingEvaluation => ({
  autoMergeEnabled: false,
  botApproved: false,
  changedLines: 20,
  paths: ['src/a.ts'],
  requiredApprovers: 1,
  riskClass: 'LOW',
  trustedApprovers: 0,
  ...over,
});

const input = (over: Partial<RoutingInput> = {}): RoutingInput => ({
  evaluation: evaluation(),
  isDraft: false,
  status: 'OPEN',
  ...over,
});

describe('decideNeedsHuman', () => {
  it('asks for a person on a ready, evaluated pull request by default', () => {
    expect(decideNeedsHuman(input(), POLICY)).toMatchObject({ needsHuman: true, reason: 'risk' });
  });

  it('needs nobody for a closed pull request or a draft', () => {
    expect(decideNeedsHuman(input({ status: 'MERGED' }), POLICY).reason).toBe('not_open');
    expect(decideNeedsHuman(input({ isDraft: true }), POLICY)).toMatchObject({
      needsHuman: false,
      reason: 'draft',
    });
  });

  it('fails closed without an evaluation at the current head', () => {
    expect(decideNeedsHuman(input({ evaluation: null }), POLICY)).toMatchObject({
      needsHuman: true,
      reason: 'not_evaluated',
    });
  });

  it('needs nobody once the required trusted approvals stand, even for a HIGH change', () => {
    const decision = decideNeedsHuman(
      input({
        evaluation: evaluation({ requiredApprovers: 2, riskClass: 'HIGH', trustedApprovers: 2 }),
      }),
      POLICY
    );
    expect(decision).toMatchObject({ needsHuman: false, reason: 'approvals_met' });
  });

  it('leaves a LOW change off the queue when the minimum risk is STANDARD', () => {
    const policy = { ...POLICY, humanMinRisk: 'STANDARD' as const };
    expect(decideNeedsHuman(input(), policy)).toMatchObject({
      needsHuman: false,
      reason: 'below_threshold',
    });
    expect(
      decideNeedsHuman(input({ evaluation: evaluation({ riskClass: 'STANDARD' }) }), policy)
        .needsHuman
    ).toBe(true);
  });

  it('skips a bot-approved, armed change only when the policy says so', () => {
    const botApproved = input({
      evaluation: evaluation({ autoMergeEnabled: true, botApproved: true }),
    });
    const lenient = { ...POLICY, humanMinRisk: 'STANDARD' as const };
    expect(decideNeedsHuman(botApproved, lenient).reason).toBe('bot_approved');
    const strict = { ...lenient, skipWhenBotApproved: false };
    expect(decideNeedsHuman(botApproved, strict).reason).toBe('below_threshold');
    // With the default minimum risk of LOW the change asks for a person whatever the bot did.
    expect(decideNeedsHuman(botApproved, POLICY).needsHuman).toBe(true);
    // Approved but not armed: the bot skip does not apply.
    expect(
      decideNeedsHuman(input({ evaluation: evaluation({ botApproved: true }) }), lenient).reason
    ).toBe('below_threshold');
  });

  it('a path rule or a size rule outranks a bot approval and names every reason', () => {
    const policy: ReviewRouting = {
      ...POLICY,
      humanAboveLines: 10,
      humanMinRisk: 'HIGH',
      humanPaths: ['src/payments/**'],
    };
    const decision = decideNeedsHuman(
      input({
        evaluation: evaluation({
          autoMergeEnabled: true,
          botApproved: true,
          changedLines: 50,
          paths: ['docs/x.md', 'src/payments/charge.ts'],
        }),
      }),
      policy
    );
    expect(decision).toEqual({
      matchedPath: 'src/payments/charge.ts',
      needsHuman: true,
      reason: 'path',
      reasons: ['path', 'size'],
    });
  });

  it('does not apply a size rule to a row that recorded no line count', () => {
    const policy = { ...POLICY, humanAboveLines: 10, humanMinRisk: 'HIGH' as const };
    expect(
      decideNeedsHuman(input({ evaluation: evaluation({ changedLines: null }) }), policy).needsHuman
    ).toBe(false);
  });
});

describe('review routing override', () => {
  it('merges only the keys a repository sets', () => {
    expect(mergeReviewRouting(POLICY, { humanMinRisk: 'HIGH', humanPaths: ['a/**'] })).toEqual({
      ...POLICY,
      humanMinRisk: 'HIGH',
      humanPaths: ['a/**'],
    });
  });

  it('reads a stored value that does not parse as no override', () => {
    expect(parseReviewRoutingOverride(null)).toEqual({});
    expect(parseReviewRoutingOverride({ humanMinRisk: 'EXTREME' })).toEqual({});
    expect(parseReviewRoutingOverride({ extra: 1 })).toEqual({});
    expect(parseReviewRoutingOverride({ humanMinRisk: 'HIGH' })).toEqual({ humanMinRisk: 'HIGH' });
  });
});
