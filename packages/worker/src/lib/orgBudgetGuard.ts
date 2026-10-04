import { configCacheTtlMs, withCache } from '@auto-swe/shared/config/cache';
import { prisma } from '@auto-swe/shared/db';
import { billedOrgId, orgMonthSpend, usdToCents } from '@auto-swe/shared/lib/billing';
import { ApplicationFailure } from '@temporalio/activity';
import { logWarn } from './activityLog.js';
import { currentSpendOwner } from './spendOwner.js';

/**
 * The org whose monthly USD cap this call's spend counts against, found the way
 * billing finds it (`finalizeRun`, `orgMonthSpend`; the order is `billedOrgId`):
 * the run's work request's connection, else — when the request names none, as
 * an epic child's and a scheduled fire's do not — the run's own connection,
 * else the ledger row's repository. So a PRD run and a code-route channel
 * task, which bill their org through the request's connection, are capped
 * like any run.
 *
 * `stable` is true once a run or a repository-bearing ledger row exists: the
 * answer is then a property of rows that do not change, so the caller may cache
 * it. A workflow with neither (epic planning, authoring, scheduled evals) has no
 * rows to read, and its org is the spend owner the activity declared, which the
 * caller reads from the ambient context and never caches.
 */
async function resolveBilledOrg(
  workflowId: string
): Promise<{ orgId: string | null; stable: boolean }> {
  const team = { select: { orgId: true } } as const;
  const [run, ledger] = await Promise.all([
    prisma.workflowRun.findUnique({
      select: {
        connection: { select: { team } },
        workRequest: { select: { connection: { select: { team } }, connectionId: true } },
      },
      where: { workflowId },
    }),
    prisma.activeWorkflow.findFirst({
      select: { repository: { select: { team } } },
      where: { temporalWorkflowId: workflowId },
    }),
  ]);
  const viaLedger = ledger?.repository?.team?.orgId;
  const orgId = billedOrgId({
    ledgerOrgId: viaLedger,
    requestConnectionId: run?.workRequest?.connectionId,
    requestOrgId: run?.workRequest?.connection?.team?.orgId,
    runOrgId: run?.connection?.team?.orgId,
  });
  return { orgId, stable: run != null || viaLedger != null };
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
    const resolved = await withCache(
      `org-budget-owner:${workflowId}`,
      ttl,
      () => resolveBilledOrg(workflowId),
      (r) => r.stable
    );
    // Only the row-derived answer is shared: a spend owner is declared per
    // activity, so concurrent activities of one workflow id can differ.
    orgId = resolved.stable ? resolved.orgId : ((await currentSpendOwner()).orgId ?? null);
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
