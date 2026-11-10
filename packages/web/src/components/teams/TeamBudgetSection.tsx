'use client';

import type { TeamBudgetSettings } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useState } from 'react';
import { BudgetMeter } from '@/components/teams/BudgetMeter';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useTeamBudget, useTeamBudgetStatus, useUpdateTeamBudget } from '@/hooks/useTeamBudget';
import { errMsg } from '@/lib/errors';
import {
  centsToDollarsInput,
  dollarsInputToCents,
  formatCents,
  thresholdInputToPercent,
} from '@/lib/teamBudget';

function BudgetForm({ budget, teamId }: { budget: TeamBudgetSettings; teamId: string }) {
  const update = useUpdateTeamBudget(teamId);
  const [cap, setCap] = useState(centsToDollarsInput(budget.monthlyBudgetUsdCents));
  const [threshold, setThreshold] = useState(
    budget.budgetAlertThresholdPercent === null ? '' : String(budget.budgetAlertThresholdPercent)
  );
  const [attempted, setAttempted] = useState(false);
  const [saved, setSaved] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const capResult = dollarsInputToCents(cap);
  const thresholdResult = thresholdInputToPercent(threshold);
  const capError = attempted && !capResult.ok ? capResult.error : undefined;
  const thresholdError = attempted && !thresholdResult.ok ? thresholdResult.error : undefined;
  const hasCap = budget.monthlyBudgetUsdCents !== null;
  const unchanged: boolean =
    capResult.ok &&
    thresholdResult.ok &&
    capResult.value === budget.monthlyBudgetUsdCents &&
    thresholdResult.value === budget.budgetAlertThresholdPercent;

  async function save(body: { cap: number | null; threshold: number | null }) {
    setServerError(null);
    setSaved(false);
    try {
      await update.mutateAsync({
        budgetAlertThresholdPercent: body.threshold,
        monthlyBudgetUsdCents: body.cap,
      });
      setSaved(true);
    } catch (e) {
      setServerError(errMsg(e, 'Could not update the budget.'));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (!capResult.ok || !thresholdResult.ok) {
      return;
    }
    await save({ cap: capResult.value, threshold: thresholdResult.value });
  }

  async function handleClear() {
    setCap('');
    setThreshold('');
    setAttempted(false);
    await save({ cap: null, threshold: null });
  }

  return (
    <form className="space-y-4" noValidate onSubmit={(e) => void handleSubmit(e)}>
      {serverError ? <Alert variant="error">{serverError}</Alert> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          error={capError}
          hint="Leave blank for no team cap. Whole dollars or cents, such as 500 or 500.50."
          inputMode="decimal"
          label="Monthly cap (USD)"
          onChange={(e) => {
            setCap(e.target.value);
            setSaved(false);
          }}
          prefix="$"
          value={cap}
        />
        <Input
          error={thresholdError}
          hint="Warn at this share of the cap, 1 to 100. Blank uses the default."
          inputMode="numeric"
          label="Alert threshold (%)"
          onChange={(e) => {
            setThreshold(e.target.value);
            setSaved(false);
          }}
          value={threshold}
        />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span aria-live="polite" className="mr-auto text-xs text-paper-500">
          {saved ? 'Budget saved.' : ''}
        </span>
        {hasCap && (
          <Button disabled={update.isPending} onClick={() => void handleClear()} variant="ghost">
            Clear team cap
          </Button>
        )}
        <Button disabled={update.isPending || unchanged} type="submit" variant="primary">
          {update.isPending ? 'Saving…' : 'Save budget'}
        </Button>
      </div>
    </form>
  );
}

/**
 * A team's own monthly budget, for the team's ADMIN, an ORG_ADMIN of its organization and a
 * platform ADMIN. The caller decides who sees it; the gateway enforces the same rule.
 */
export function TeamBudgetSection({
  canManageCredentials,
  teamId,
}: {
  /** Whether the caller can reach the Models page, where a team's own provider key is added. */
  canManageCredentials: boolean;
  teamId: string;
}) {
  const budget = useTeamBudget(teamId);
  const status = useTeamBudgetStatus(teamId);
  return (
    <div className="space-y-6" data-testid="team-budget-section">
      <Card>
        <CardHeader className="mb-1">
          <CardTitle>Monthly budget</CardTitle>
        </CardHeader>
        <p className="mb-4 text-sm text-paper-400">
          A team cap applies in addition to the organization’s: when both are set, the tighter one
          binds and new work is refused once it is used up. Work on repositories shared with this
          team from other teams is billed to the team that owns the repository, not to this one.
        </p>
        <QueryBoundary
          error={budget.error}
          isError={budget.isError}
          isFetching={budget.isFetching}
          isLoading={budget.isLoading}
          label="team budget"
          onRetry={() => void budget.refetch()}
          shape="detail"
        >
          {budget.data && (
            <div className="space-y-5">
              <div>
                <p className="tabular text-2xl font-semibold text-paper-50" data-testid="spend">
                  {formatCents(budget.data.monthSpendUsdCents)}
                  <span className="ml-2 text-sm font-normal text-paper-400">
                    {budget.data.monthlyBudgetUsdCents === null
                      ? 'spent this month, no team cap set'
                      : `of ${formatCents(budget.data.monthlyBudgetUsdCents)} this month`}
                  </span>
                </p>
                <BudgetMeter budget={status.data} className="mt-3" variant="full" />
              </div>
              <BudgetForm budget={budget.data} teamId={teamId} />
            </div>
          )}
        </QueryBoundary>
      </Card>

      {canManageCredentials && (
        <Card>
          <CardHeader className="mb-1">
            <CardTitle>Provider key</CardTitle>
          </CardHeader>
          <p className="text-sm text-paper-400">
            A team may bring its own model provider key, so its runs are billed to its own account
            rather than the platform’s. Add a team-scoped credential on the{' '}
            <Link
              className="text-paper-100 underline decoration-paper-600 underline-offset-2 hover:decoration-current"
              href="/models"
            >
              Model configuration
            </Link>{' '}
            page.
          </p>
        </Card>
      )}
    </div>
  );
}
