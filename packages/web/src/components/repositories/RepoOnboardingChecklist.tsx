'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button, ButtonLink } from '@/components/ui/Button';
import { useDismissOnboardingChecklist } from '@/hooks/useRepositoryOnboarding';
import { errMsg } from '@/lib/errors';

export function RepoOnboardingChecklist({
  repo,
  canManage,
  onTestAccess,
  onOnboardingPr,
  onSetup,
  onStack,
}: {
  repo: RepositorySummary;
  canManage: boolean;
  onTestAccess: () => void;
  onOnboardingPr: () => void;
  onSetup: () => void;
  onStack: () => void;
}) {
  const dismiss = useDismissOnboardingChecklist(repo.id);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = repo.onboardingChecklist;
  if (
    repo.type !== 'git_repo' ||
    !canManage ||
    !c ||
    c.dismissed ||
    dismissed ||
    (c.accessVerified &&
      c.stackScanned &&
      c.setupHealthy &&
      c.onboardingPrOpened &&
      c.firstRunLaunched)
  ) {
    return null;
  }
  const items = [
    { action: onTestAccess, done: c.accessVerified, label: 'Access tested OK' },
    { action: onStack, done: c.stackScanned, label: 'Stack scan done' },
    { action: onSetup, done: c.setupHealthy, label: 'No unresolved setup blockers' },
    { action: onOnboardingPr, done: c.onboardingPrOpened, label: 'Onboarding PR opened' },
  ];
  return (
    <details className="mt-2 rounded border border-ink-600 p-2 text-sm">
      <summary className="cursor-pointer">First-run checklist</summary>
      <ul className="mt-2 space-y-1">
        {items.map((item) => (
          <li key={item.label}>
            <span aria-label={item.done ? 'Complete' : 'Incomplete'} role="img">
              {item.done ? '✓' : '○'}{' '}
            </span>
            {item.label === 'Onboarding PR opened' && c.onboardingPrUrl ? (
              <ButtonLink href={c.onboardingPrUrl} size="sm" variant="ghost">
                {item.label}
              </ButtonLink>
            ) : (
              <Button onClick={item.action} size="sm" variant="ghost">
                {item.label}
              </Button>
            )}
          </li>
        ))}
        <li>
          <span aria-label={c.firstRunLaunched ? 'Complete' : 'Incomplete'} role="img">
            {c.firstRunLaunched ? '✓' : '○'}{' '}
          </span>
          <ButtonLink href={`/start?team=${repo.team.id}`} size="sm" variant="ghost">
            First run launched
          </ButtonLink>
        </li>
      </ul>
      {error && <Alert variant="error">{error}</Alert>}
      <Button
        disabled={dismiss.isPending}
        onClick={async () => {
          setError(null);
          try {
            await dismiss.mutateAsync();
            setDismissed(true);
          } catch (err) {
            setError(errMsg(err, 'Checklist could not be dismissed.'));
          }
        }}
        size="sm"
        variant="ghost"
      >
        Dismiss checklist
      </Button>
    </details>
  );
}
