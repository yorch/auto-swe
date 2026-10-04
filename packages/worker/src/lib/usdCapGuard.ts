import { prisma } from '@auto-swe/shared/db';
import { ApplicationFailure } from '@temporalio/activity';
import { currentWorkflowId } from './activityContext.js';
import { getModelPrice } from './costTracking.js';
import { getModelSpec } from './models.js';
import { resolveBilledOrg } from './orgBudgetGuard.js';
import { currentSpendOwner } from './spendOwner.js';

/** The `ApplicationFailure` type of a refused call; the run viewer keys on it. */
export const MODEL_UNPRICED = 'MODEL_UNPRICED';

/**
 * The failure type when the catalog could not be read, so "no price" cannot be
 * told from "price not loaded yet". Retryable, unlike {@link MODEL_UNPRICED}.
 */
export const MODEL_PRICE_UNAVAILABLE = 'MODEL_PRICE_UNAVAILABLE';

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
 * monthly budget (accrued at finalize along `billedOrgId`, gated at launch and
 * before each call).
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

  // The org cap counts a run through the org billing attributes it to
  // (`resolveBilledOrg`, the rule the mid-run guard caps by): the request's
  // connection, else the run's own, else the ledger row's repository. A PRD run
  // and a code-route channel task bill through a connection, so they are capped
  // here too. A workflow with neither run nor repository-bearing ledger row is
  // counted through the owner its trace rows are stamped with
  // (`orgMonthSpend`'s runless spend).
  let workflowId: string;
  try {
    workflowId = currentWorkflowId();
  } catch {
    return null; // Outside an activity: no run, no ledger row.
  }
  const resolved = await resolveBilledOrg(workflowId);
  const orgId = resolved.stable ? resolved.orgId : ((await currentSpendOwner()).orgId ?? null);
  if (!orgId) {
    return null; // No org bills this call: it is outside every org cap.
  }
  const org = await prisma.organization.findUnique({
    select: { monthlyBudgetUsdCents: true },
    where: { id: orgId },
  });
  return org?.monthlyBudgetUsdCents != null ? 'organization' : null;
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
  const price = await getModelPrice(modelSpec);
  if (price.known) {
    return;
  }
  const cap = await findUsdCap(scope);
  if (!cap) {
    return;
  }
  if (!price.catalogAvailable) {
    // A cold worker whose first catalog read failed prices nothing from the
    // catalog for about one cache window, so "unknown" here may be a price that
    // exists. Telling the admin to add it would be wrong, and a non-retryable
    // refusal would turn a database blip into a permanent failure. Fail closed
    // all the same (the cap cannot be trusted to count this call), but retryably.
    throw ApplicationFailure.retryable(
      `The model catalog could not be read, so the price of "${modelSpec}" is not known and ` +
        `${CAP_LABEL[cap]} is a USD cap. Retrying; this clears when the catalog is readable.`,
      MODEL_PRICE_UNAVAILABLE,
      { cap, modelSpec }
    );
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

/**
 * {@link assertModelPricedForUsdCap} for a call about to be made as agent `role`
 * on the ambient run context. The one entry point for the paths that bind their
 * model by role (implementer and its fix sessions, the reviewers, planner,
 * decomposers, security gate, memory passes), so none of them can drift in how
 * it asks.
 */
export async function assertRolePricedForUsdCap(role: string): Promise<void> {
  await assertModelPricedForUsdCap(await getModelSpec(role));
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
