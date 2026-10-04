import { configCacheTtlMs, withCache } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { orgMonthSpend, usdToCents } from '@auto-swe/shared/lib/billing';
import { ApplicationFailure } from '@temporalio/activity';
import { logWarn } from './activityLog.js';
import { currentSpendOwner } from './spendOwner.js';

/**
 * The org whose monthly USD cap this call's spend counts against, or `null`.
 *
 * Mirrors how the cap counts spend (`orgMonthSpend`): a run through its ledger
 * row's repository, and a workflow with neither a repository nor a run (an
 * epic's own planning, authoring, scheduled evals) through the spend owner its
 * trace rows are stamped with. A run with no repository on its ledger row is a
 * channel task, whose cost is the channel's, not an org's.
 *
 * Only the repository answer is cached by the caller: a spend owner is declared
 * per activity, and a workflow id can be reused across executions.
 */
async function resolveCappedOrg(
  workflowId: string
): Promise<{ orgId: string | null; viaRepository: boolean }> {
  const ledger = await prisma.activeWorkflow.findFirst({
    select: { repository: { select: { team: { select: { orgId: true } } } } },
    where: { temporalWorkflowId: workflowId },
  });
  const viaRepository = ledger?.repository?.team?.orgId;
  if (viaRepository) {
    return { orgId: viaRepository, viaRepository: true };
  }
  const run = await prisma.workflowRun.findUnique({
    select: { id: true },
    where: { workflowId },
  });
  if (run) {
    return { orgId: null, viaRepository: false };
  }
  return { orgId: (await currentSpendOwner()).orgId ?? null, viaRepository: false };
}

interface OrgCapState {
  capCents: number | null;
  spentUsd: number;
}

/**
 * Refuses the next model call once the organization has spent its monthly USD
 * cap, with a non-retryable `BUDGET_EXCEEDED` (the type the token-tier and
 * runless caps use, so every caller that treats those as "stop, don't retry"
 * treats this the same).
 *
 * The launch gate stops new runs at the cap; this stops the runs already
 * going, so a burst of long runs started just under it cannot spend on without
 * limit. Spend is `orgMonthSpend` — finalized, in-flight and runless — read
 * through a per-org cache of one config-cache window (30 s by default). The
 * cap is read inside the same cached entry, so raising it lets calls through
 * again within one window and the cache cannot pin a refusal for longer. The
 * price is one window of spend after the cap is reached.
 *
 * Fails open: a read that fails is logged and the call proceeds, as the other
 * budget reads do — failing a run over a database blip refuses work no cap
 * was proven to cover. An org with no cap costs one cached read per window.
 */
export async function assertOrgBudgetAvailable(workflowId: string, label: string): Promise<void> {
  let orgId: string | null;
  let state: OrgCapState;
  try {
    const ttl = configCacheTtlMs();
    ({ orgId } = await withCache(
      `org-budget-owner:${workflowId}`,
      ttl,
      () => resolveCappedOrg(workflowId),
      (resolved) => resolved.viaRepository
    ));
    if (!orgId) {
      return;
    }
    const id = orgId;
    state = await withCache(`org-budget:${id}`, ttl, async () => {
      const org = await prisma.organization.findUnique({
        select: { monthlyBudgetUsdCents: true },
        where: { id },
      });
      const capCents = org?.monthlyBudgetUsdCents ?? null;
      if (capCents == null) {
        return { capCents, spentUsd: 0 };
      }
      return { capCents, spentUsd: (await orgMonthSpend(prisma, id)).totalUsd };
    });
  } catch (err) {
    logWarn('Organization budget unreadable — the call is not capped', {
      error: err instanceof Error ? err.message : String(err),
      workflowId,
    });
    return;
  }
  if (state.capCents == null || usdToCents(state.spentUsd) < state.capCents) {
    return;
  }
  throw ApplicationFailure.nonRetryable(
    `Organization monthly budget already exhausted before ${label}: ` +
      `$${state.spentUsd.toFixed(2)} spent of a ${state.capCents}-cent cap`,
    'BUDGET_EXCEEDED',
    { cap: 'organization', capCents: state.capCents, label, orgId }
  );
}
