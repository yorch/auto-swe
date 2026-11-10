import { z } from 'zod';
import { replaceUnsafe } from './brief.js';
import {
  countGlobStars,
  globCost,
  isValidGlob,
  MAX_BOT_APPROVAL_PATHS,
  MAX_GLOB_LENGTH,
  MAX_GLOB_STARS,
  MAX_PATH_LENGTH,
  matchesAny,
} from './paths.js';
import { MAX_FILE_GLOB_COST } from './policy.js';
import type { ChangedFile, RiskClass } from './types.js';

/**
 * Which pull requests need a person's attention, and in what order a reviewer should meet them.
 *
 * This is routing, not enforcement. The approvals a pull request needs are still decided by its
 * risk class and by the host's branch rules; routing only decides which open pull requests the
 * queue puts in front of a person, and says why. The default policy asks for a person on every
 * ready, evaluated pull request that does not already have its approvals, so an unconfigured
 * repository changes nothing but the order.
 *
 * Routing may order and label, but it fails safe: anything uncertain (no evaluation at the
 * current head, a path list that was cut, a path too long to match, a match that ran out of its
 * work budget) means a person is needed.
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

/**
 * The override a stored column holds. Each key is read on its own, like the registry reads a
 * setting: a key that fails its schema is dropped and inherits, and the others still apply.
 */
export function parseReviewRoutingOverride(stored: unknown): ReviewRoutingOverride {
  if (
    stored === null ||
    stored === undefined ||
    typeof stored !== 'object' ||
    Array.isArray(stored)
  ) {
    return {};
  }
  const raw = stored as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(reviewRoutingOverrideSchema.shape) as (keyof ReviewRouting)[]) {
    if (raw[key] === undefined) {
      continue;
    }
    const parsed = reviewRoutingOverrideSchema.shape[key].safeParse(raw[key]);
    if (parsed.success && parsed.data !== undefined) {
      out[key] = parsed.data;
    }
  }
  return out as ReviewRoutingOverride;
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

/**
 * The keys of `proposed` that would make routing LOOSER than `inherited`, the value the settings
 * give the repository's team and organization. The settings are ADMIN-only, so a lead's override
 * may only ask for a person more often: a lower minimum risk, a lower non-zero size limit, more
 * always-human globs, a smaller quick-review size, the bot-approval skip off. A key that equals
 * what `existing` already stores is not a change and is not reported.
 */
export function reviewRoutingLoosenings(
  inherited: ReviewRouting,
  proposed: ReviewRoutingOverride,
  existing: ReviewRoutingOverride = {}
): (keyof ReviewRouting)[] {
  const loosened: (keyof ReviewRouting)[] = [];
  const changed = (key: keyof ReviewRouting) =>
    proposed[key] !== undefined && JSON.stringify(proposed[key]) !== JSON.stringify(existing[key]);
  if (
    changed('humanMinRisk') &&
    RISK_RANK[proposed.humanMinRisk as RiskClass] > RISK_RANK[inherited.humanMinRisk]
  ) {
    loosened.push('humanMinRisk');
  }
  if (changed('humanAboveLines')) {
    const wanted = proposed.humanAboveLines as number;
    // 0 is "no size rule": the loosest value.
    if (
      wanted === 0
        ? inherited.humanAboveLines !== 0
        : inherited.humanAboveLines !== 0 && wanted > inherited.humanAboveLines
    ) {
      loosened.push('humanAboveLines');
    }
  }
  if (changed('humanPaths')) {
    const wanted = new Set((proposed.humanPaths as string[]).map((glob) => glob.toLowerCase()));
    if (inherited.humanPaths.some((glob) => !wanted.has(glob.toLowerCase()))) {
      loosened.push('humanPaths');
    }
  }
  if (
    changed('quickReviewMaxLines') &&
    (proposed.quickReviewMaxLines as number) > inherited.quickReviewMaxLines
  ) {
    loosened.push('quickReviewMaxLines');
  }
  if (
    changed('skipWhenBotApproved') &&
    proposed.skipWhenBotApproved &&
    !inherited.skipWhenBotApproved
  ) {
    loosened.push('skipWhenBotApproved');
  }
  return loosened;
}

/** Most changed paths (new and previous together) a pull request's routing facts keep. */
export const MAX_ROUTING_PATHS = 5000;
/** Most characters of path text the routing facts keep; past it the facts are marked cut. */
export const MAX_ROUTING_PATH_CHARS = 100_000;

/**
 * What routing reads of an evaluation beyond its counts: every changed path, the previous path of
 * every rename, and whether the path list is cut. A cut list means some path was not kept, so no
 * always-human glob can be shown not to match.
 */
export type RoutingFacts = {
  paths: string[];
  previousPaths: string[];
  truncated: boolean;
};

/** The facts to store with an evaluation, from the files the pull request lists. */
export function buildRoutingFacts(
  files: readonly Pick<ChangedFile, 'path' | 'previousPath'>[],
  opts: { listTruncated: boolean }
): RoutingFacts {
  const paths = new Set<string>();
  const previousPaths = new Set<string>();
  let chars = 0;
  let truncated = opts.listTruncated;
  const keep = (set: Set<string>, path: string): void => {
    if (set.has(path)) {
      return;
    }
    // A path the matcher cannot take is not kept; its absence is what marks the list cut.
    if (
      path.length > MAX_PATH_LENGTH ||
      paths.size + previousPaths.size >= MAX_ROUTING_PATHS ||
      chars + path.length > MAX_ROUTING_PATH_CHARS
    ) {
      truncated = true;
      return;
    }
    chars += path.length;
    set.add(path);
  };
  for (const file of files) {
    keep(paths, file.path);
    if (file.previousPath !== undefined && file.previousPath !== file.path) {
      keep(previousPaths, file.previousPath);
    }
  }
  return {
    paths: [...paths],
    previousPaths: [...previousPaths],
    truncated,
  };
}

const routingFactsSchema = z.object({
  paths: z.array(z.string()).max(MAX_ROUTING_PATHS),
  previousPaths: z.array(z.string()).max(MAX_ROUTING_PATHS),
  truncated: z.boolean(),
});

/** The facts a stored column holds; anything that does not parse is no facts at all (unknown). */
export function parseRoutingFacts(stored: unknown): RoutingFacts | null {
  const parsed = routingFactsSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/**
 * Work the always-human path match may spend in one request, in glob tokens times path
 * characters (one unit is about three nanoseconds). The matcher cannot be interrupted, so the
 * bound is kept by counting; a path the budget cannot cover reads as a match.
 */
export const ROUTING_MATCH_BUDGET = 400_000_000;

export type RoutingMatchBudget = { remaining: number };

export function createRoutingMatchBudget(units: number = ROUTING_MATCH_BUDGET): RoutingMatchBudget {
  return { remaining: units };
}

/** The evaluation of a pull request's current head, as routing reads it. */
export type RoutingEvaluation = {
  autoMergeEnabled: boolean;
  botApproved: boolean;
  /** Additions plus deletions over the listed files; null for a row that did not record them. */
  changedLines: number | null;
  /**
   * Whether a person's request for changes stood when the evaluation ran. A row from before it was
   * recorded reads as standing when any review at the head asked for changes.
   */
  humanObjection: boolean;
  requiredApprovers: number;
  riskClass: RiskClass;
  /** Every changed path and rename source; null when the row recorded none (read as unknown). */
  routing: RoutingFacts | null;
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
  'bot_approved_review',
  'below_threshold',
  'not_evaluated',
  'changes_requested',
  'path',
  'risk',
  'size',
] as const;
export type RoutingReason = (typeof ROUTING_REASONS)[number];

export type RoutingDecision = {
  /**
   * The first path (or rename source) that matched `humanPaths`, made safe to show; null for any
   * other reason, and for a `path` reason that holds because the paths could not all be checked.
   */
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

const MAX_SHOWN_PATH = 200;

/** A path as shown to a person: invisible and bidirectional characters replaced, then clipped. */
function shownPath(path: string): string {
  const text = Array.from(replaceUnsafe(path, '?'));
  return text.length > MAX_SHOWN_PATH
    ? `${text.slice(0, MAX_SHOWN_PATH).join('')}...`
    : text.join('');
}

type PathVerdict = { matched: string | null; unchecked: boolean };

/**
 * Whether the change touches an always-human path. A denylist fails open when a path is skipped,
 * so every uncertainty is a match: a path the matcher cannot take (over the length bound), a list
 * the evaluation cut or never recorded, and a path the request's work budget no longer covers.
 * A rename is matched at both ends, so moving a file out of a protected directory still asks.
 */
function checkHumanPaths(
  routing: RoutingEvaluation['routing'],
  globs: readonly string[],
  budget: RoutingMatchBudget
): PathVerdict {
  if (globs.length === 0) {
    return { matched: null, unchecked: false };
  }
  if (routing === null || routing.truncated) {
    return { matched: null, unchecked: true };
  }
  const perChar = globs.reduce((sum, glob) => sum + Math.max(1, globCost(glob)), 0);
  for (const path of [...routing.paths, ...routing.previousPaths]) {
    if (path.length > MAX_PATH_LENGTH || path.toLowerCase().length > MAX_PATH_LENGTH) {
      return { matched: shownPath(path), unchecked: false };
    }
    budget.remaining -= perChar * (path.length + 1);
    if (budget.remaining < 0) {
      return { matched: null, unchecked: true };
    }
    if (matchesAny(path, globs)) {
      return { matched: shownPath(path), unchecked: false };
    }
  }
  return { matched: null, unchecked: false };
}

/**
 * Whether a pull request needs a person, and why. Pure, and fail-closed: a pull request with no
 * evaluation at its current head needs a person, because nothing says it does not. A pull request
 * that is not open, or is a draft, needs nobody yet.
 *
 * Order of the rules once a pull request is open, ready and evaluated:
 *
 * 1. `path`: always asks. An always-human path means always, whatever approvals stand.
 * 2. `approvals_met`: the trusted approvals reach the requirement and no person's request for
 *    changes stands; nobody has more reviewing to do. With a request for changes standing the
 *    approvals do not clear the pull request: it reads `changes_requested`.
 * 3. `risk` and `size`: ask. They apply after approvals, so a change that already has what it
 *    needs is not sent for another look because of how risky it is.
 * 4. A standing bot approval with auto-merge armed: skipped only when `skipWhenBotApproved` is
 *    on (`bot_approved`); with it off a person still looks (`bot_approved_review`).
 * 5. `below_threshold`.
 */
export function decideNeedsHuman(
  input: RoutingInput,
  policy: ReviewRouting,
  budget: RoutingMatchBudget = createRoutingMatchBudget()
): RoutingDecision {
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
  const reasons: RoutingReason[] = [];
  const paths = checkHumanPaths(evaluation.routing, policy.humanPaths, budget);
  if (paths.matched !== null || paths.unchecked) {
    reasons.push('path');
  }
  const approvalsMet =
    evaluation.trustedApprovers !== null &&
    evaluation.trustedApprovers >= evaluation.requiredApprovers;
  if (approvalsMet && !evaluation.humanObjection && reasons.length === 0) {
    return decided(false, ['approvals_met']);
  }
  if (approvalsMet && evaluation.humanObjection) {
    reasons.push('changes_requested');
  }
  if (RISK_RANK[evaluation.riskClass] >= RISK_RANK[policy.humanMinRisk]) {
    reasons.push('risk');
  }
  // A row that recorded no line count cannot show it is small, so the size rule asks.
  if (
    policy.humanAboveLines > 0 &&
    (evaluation.changedLines === null || evaluation.changedLines > policy.humanAboveLines)
  ) {
    reasons.push('size');
  }
  if (reasons.length > 0) {
    return decided(true, reasons, paths.matched);
  }
  if (evaluation.botApproved && evaluation.autoMergeEnabled) {
    return policy.skipWhenBotApproved
      ? decided(false, ['bot_approved'])
      : decided(true, ['bot_approved_review']);
  }
  return decided(false, ['below_threshold']);
}
