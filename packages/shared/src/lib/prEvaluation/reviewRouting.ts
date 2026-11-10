import { z } from 'zod';
import {
  countGlobStars,
  globCost,
  isValidGlob,
  MAX_BOT_APPROVAL_PATHS,
  MAX_GLOB_LENGTH,
  MAX_GLOB_STARS,
  matchesAny,
} from './paths.js';
import { MAX_FILE_GLOB_COST } from './policy.js';
import type { RiskClass } from './types.js';

/**
 * Which pull requests need a person's attention, and in what order a reviewer should meet them.
 *
 * This is routing, not enforcement. The approvals a pull request needs are still decided by its
 * risk class and by the host's branch rules; routing only decides which open pull requests the
 * queue puts in front of a person, and says why. The default policy asks for a person on every
 * ready, evaluated pull request that does not already have its approvals or a standing bot
 * approval, so an unconfigured repository changes nothing but the order.
 */

export const REVIEW_RISK_CLASSES = ['LOW', 'STANDARD', 'HIGH'] as const;

/** Globs that always need a person: valid and bounded exactly as the bot-approval globs are. */
export const reviewRoutingPathsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(MAX_GLOB_LENGTH)
      .refine(isValidGlob, 'not a valid glob')
      .refine((g) => countGlobStars(g) <= MAX_GLOB_STARS, `more than ${MAX_GLOB_STARS} * tokens`)
  )
  .max(MAX_BOT_APPROVAL_PATHS)
  .refine(
    (list) => list.reduce((sum, g) => sum + globCost(g), 0) <= MAX_FILE_GLOB_COST,
    'globs are too expensive to evaluate together'
  );

export const reviewRoutingLineCount = z.number().int().min(0).max(1_000_000);

export type ReviewRouting = {
  /** Always ask for a person when the risk class is at or above this. `LOW` asks for everyone. */
  humanMinRisk: RiskClass;
  /** Always ask for a person when more lines than this changed; 0 turns the size rule off. */
  humanAboveLines: number;
  /** A change touching a file that matches one of these always asks for a person. */
  humanPaths: string[];
  /** A `LOW` change of at most this many lines is a quick review: batched with its peers. */
  quickReviewMaxLines: number;
  /** A change the approver App approved, with auto-merge armed, does not ask for a person. */
  skipWhenBotApproved: boolean;
};

/** What one repository may set; a key left out inherits the setting. */
export type ReviewRoutingOverride = Partial<ReviewRouting>;

export const reviewRoutingOverrideSchema = z
  .object({
    humanAboveLines: reviewRoutingLineCount.optional(),
    humanMinRisk: z.enum(REVIEW_RISK_CLASSES).optional(),
    humanPaths: reviewRoutingPathsSchema.optional(),
    quickReviewMaxLines: reviewRoutingLineCount.optional(),
    skipWhenBotApproved: z.boolean().optional(),
  })
  .strict();

/** The override a stored column holds; anything that does not parse is no override at all. */
export function parseReviewRoutingOverride(stored: unknown): ReviewRoutingOverride {
  if (stored === null || stored === undefined) {
    return {};
  }
  const parsed = reviewRoutingOverrideSchema.safeParse(stored);
  return parsed.success ? parsed.data : {};
}

/** The repository's override over the settings at its scope. */
export function mergeReviewRouting(
  base: ReviewRouting,
  override: ReviewRoutingOverride
): ReviewRouting {
  return {
    humanAboveLines: override.humanAboveLines ?? base.humanAboveLines,
    humanMinRisk: override.humanMinRisk ?? base.humanMinRisk,
    humanPaths: override.humanPaths ?? base.humanPaths,
    quickReviewMaxLines: override.quickReviewMaxLines ?? base.quickReviewMaxLines,
    skipWhenBotApproved: override.skipWhenBotApproved ?? base.skipWhenBotApproved,
  };
}

export const RISK_RANK: Readonly<Record<RiskClass, number>> = { HIGH: 2, LOW: 0, STANDARD: 1 };

/** The evaluation of a pull request's current head, as routing reads it. */
export type RoutingEvaluation = {
  autoMergeEnabled: boolean;
  botApproved: boolean;
  /** Additions plus deletions over the listed files; null for a row that did not record them. */
  changedLines: number | null;
  /** Every file the brief lists as one to read (skimmable files are not in it). */
  paths: readonly string[];
  requiredApprovers: number;
  riskClass: RiskClass;
  /** Distinct trusted approvals at the evaluated head; null when not recorded. */
  trustedApprovers: number | null;
};

export type RoutingInput = {
  /** The evaluation of the pull request's current head; null when it has none. */
  evaluation: RoutingEvaluation | null;
  isDraft: boolean;
  status: 'OPEN' | 'MERGED' | 'CLOSED';
};

export const ROUTING_REASONS = [
  'not_open',
  'draft',
  'approvals_met',
  'bot_approved',
  'below_threshold',
  'not_evaluated',
  'path',
  'risk',
  'size',
] as const;
export type RoutingReason = (typeof ROUTING_REASONS)[number];

export type RoutingDecision = {
  /** The first path that matched `humanPaths`; null for any other reason. */
  matchedPath: string | null;
  needsHuman: boolean;
  /** The deciding reason: the first of `reasons`. */
  reason: RoutingReason;
  /** Every reason that holds, strongest first. */
  reasons: RoutingReason[];
};

const decided = (
  needsHuman: boolean,
  reasons: RoutingReason[],
  matchedPath: string | null = null
): RoutingDecision => ({
  matchedPath,
  needsHuman,
  reason: reasons[0] as RoutingReason,
  reasons,
});

/**
 * Whether a pull request needs a person, and why. Pure, and fail-closed: a pull request with no evaluation at its
 * current head needs a person, because nothing says
 * it does not. A pull request that is not open, or is a draft, needs nobody yet.
 */
export function decideNeedsHuman(input: RoutingInput, policy: ReviewRouting): RoutingDecision {
  if (input.status !== 'OPEN') {
    return decided(false, ['not_open']);
  }
  if (input.isDraft) {
    return decided(false, ['draft']);
  }
  const evaluation = input.evaluation;
  if (!evaluation) {
    return decided(true, ['not_evaluated']);
  }
  // Enough trusted approvals already stand: nobody has more reviewing to do.
  if (
    evaluation.trustedApprovers !== null &&
    evaluation.trustedApprovers >= evaluation.requiredApprovers
  ) {
    return decided(false, ['approvals_met']);
  }
  const reasons: RoutingReason[] = [];
  const matched = evaluation.paths.find((path) => matchesAny(path, policy.humanPaths)) ?? null;
  if (matched !== null) {
    reasons.push('path');
  }
  if (RISK_RANK[evaluation.riskClass] >= RISK_RANK[policy.humanMinRisk]) {
    reasons.push('risk');
  }
  if (
    policy.humanAboveLines > 0 &&
    evaluation.changedLines !== null &&
    evaluation.changedLines > policy.humanAboveLines
  ) {
    reasons.push('size');
  }
  if (reasons.length > 0) {
    return decided(true, reasons, matched);
  }
  if (policy.skipWhenBotApproved && evaluation.botApproved && evaluation.autoMergeEnabled) {
    return decided(false, ['bot_approved']);
  }
  return decided(false, ['below_threshold']);
}
