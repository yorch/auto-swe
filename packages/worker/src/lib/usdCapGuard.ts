import { prisma } from '@auto-swe/shared/db';
import { ApplicationFailure } from '@temporalio/activity';
import { currentWorkflowId } from './activityContext.js';
import { getModelPrice } from './costTracking.js';

/** The `ApplicationFailure` type of a refused call; the run viewer keys on it. */
export const MODEL_UNPRICED = 'MODEL_UNPRICED';

/** Which USD cap a call would be counted against. */
export type UsdCapKind = 'channel' | 'organization';

const CAP_LABEL: Record<UsdCapKind, string> = {
  channel: "this channel's monthly budget",
  organization: "this organization's monthly budget",
};

/**
 * Where an unpriced model's spend would have to be counted, or `null` when
 * nothing USD-denominated is watching this call.
 *
 * The USD-denominated caps are the channel monthly budget (held and settled by
 * the channel passes, accrued by `finalizeChannelTaskRun`) and the organization
 * monthly budget (accrued from the run ledger at finalize, gated at launch).
 * The token tier budgets count tokens, so they bind at any price and are not
 * consulted here. A run's own `costUsdAccrued` is a display figure with no cap.
 */
async function findUsdCap(scope: {
  channelId?: string;
  channelCapCents?: number | null;
}): Promise<UsdCapKind | null> {
  if (scope.channelCapCents !== undefined) {
    if (scope.channelCapCents != null && scope.channelCapCents > 0) {
      return 'channel';
    }
  } else if (scope.channelId) {
    const channel = await prisma.slackChannel.findUnique({
      select: { monthlyBudgetUsdCents: true },
      where: { id: scope.channelId },
    });
    if (channel?.monthlyBudgetUsdCents != null && channel.monthlyBudgetUsdCents > 0) {
      return 'channel';
    }
  }

  // The org cap sees only runs whose ledger row reaches an organization through
  // its repository — the same path `finalizeWorkflowRun` accrues
  // `OrgMonthlyUsage` along. A channel task has no such row, and its spend never
  // reaches the org ledger, so the org cap is not at stake for it.
  let workflowId: string;
  try {
    workflowId = currentWorkflowId();
  } catch {
    return null; // Outside an activity: no run, no ledger row.
  }
  const row = await prisma.activeWorkflow.findFirst({
    select: {
      repository: {
        select: { team: { select: { organization: { select: { monthlyBudgetUsdCents: true } } } } },
      },
    },
    where: { temporalWorkflowId: workflowId },
  });
  return row?.repository?.team?.organization?.monthlyBudgetUsdCents != null ? 'organization' : null;
}

/**
 * Refuses a model call that a USD cap could not count.
 *
 * A model with no catalog price measures as $0, so spend on it never reaches a
 * USD cap: the cap silently stops binding. On a path watched by one that is a
 * hole, so the call is refused before it is made, with a non-retryable typed
 * failure that names the model and where to price it. On an uncapped path
 * nothing is at stake and the call proceeds, recorded at $0 with
 * `llm.cost_pricing_known=false` as before.
 *
 * Cheap when it matters least: a priced model returns after one cached catalog
 * read, and the cap lookups run only for an unpriced one.
 *
 * @param scope.channelCapCents the channel's monthly cap when the caller already
 *   holds the channel row. Omit it and give `channelId` to look the cap up.
 */
export async function assertModelPricedForUsdCap(
  modelSpec: string,
  scope: { channelId?: string; channelCapCents?: number | null } = {}
): Promise<void> {
  if ((await getModelPrice(modelSpec)).known) {
    return;
  }
  const cap = await findUsdCap(scope);
  if (!cap) {
    return;
  }
  throw ApplicationFailure.nonRetryable(
    `Model "${modelSpec}" has no price in the model catalog, and ${CAP_LABEL[cap]} is a USD ` +
      'cap that cannot count spend it cannot price. Add the model to the model catalog ' +
      '(/api/v1/platform/model-catalog, or the Catalog tab under model configuration) with its ' +
      'price per million tokens, or bind a priced model.',
    MODEL_UNPRICED,
    { cap, modelSpec }
  );
}

/** The {@link MODEL_UNPRICED} refusal `err` is, or wraps in its cause chain; else `null`. */
export function findUnpricedModelRefusal(err: unknown): Error | null {
  let cur: unknown = err;
  for (let i = 0; i < 16 && cur instanceof Error; i++) {
    if ((cur as { type?: unknown }).type === MODEL_UNPRICED) {
      return cur;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export function isUnpricedModelRefusal(err: unknown): boolean {
  return findUnpricedModelRefusal(err) !== null;
}
