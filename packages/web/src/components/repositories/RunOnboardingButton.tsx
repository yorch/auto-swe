'use client';

import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { type RepoOnboardingRun, useRunRepoOnboarding } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';

export function OnboardingRunLink({ run }: { run: RepoOnboardingRun }) {
  return (
    <Link
      className="underline"
      href={run.runId ? `/runs/${run.runId}` : `/requests/${run.workRequestId}`}
    >
      View onboarding run
    </Link>
  );
}

export function RunOnboardingButton({
  repositoryId,
  canRun,
}: {
  repositoryId: string;
  canRun: boolean;
}) {
  const launch = useRunRepoOnboarding();
  if (!canRun) {
    return null;
  }
  return (
    <div className="space-y-2">
      <Button disabled={launch.isPending} onClick={() => launch.mutate(repositoryId)} size="sm">
        {launch.isPending ? 'Starting onboarding…' : 'Run onboarding'}
      </Button>
      {launch.data && <OnboardingRunLink run={launch.data} />}
      {launch.isError && (
        <Alert variant="error">{errMsg(launch.error, 'Could not start onboarding')}</Alert>
      )}
    </div>
  );
}
