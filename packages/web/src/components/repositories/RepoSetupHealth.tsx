'use client';

import type { SetupBlocker } from '@auto-swe/shared/lib/setupBlocker';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { useDismissSetupBlocker, useSetupBlockers } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';

const KIND_LABELS: Record<SetupBlocker['kind'], string> = {
  egress_denied: 'Network access denied',
  git_auth: 'Git authentication failed',
  git_fetch: 'Git fetch failed',
  internal: 'Workspace setup error',
  invalid_config: 'Invalid configuration',
  lfs_missing: 'Git LFS missing',
  missing_secret: 'Missing secret',
  missing_tool: 'Missing tool',
  secret_decrypt_failed: 'Secret decryption failed',
  secret_leak: 'Secret left on disk',
  step_failed: 'Setup step failed',
  step_timeout: 'Setup step timed out',
};

export function RepoSetupHealth({
  repositoryId,
  disabled,
}: {
  repositoryId: string;
  disabled: boolean;
}) {
  const blockers = useSetupBlockers(repositoryId);
  const dismiss = useDismissSetupBlocker(repositoryId);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="space-y-3 rounded-lg border border-ink-600 p-3">
      <h4 className="text-sm font-medium text-paper-200">Setup health</h4>
      {blockers.isLoading && <p className="text-sm text-paper-400">Loading setup blockers…</p>}
      {blockers.isError && <Alert variant="error">Setup blockers could not be loaded.</Alert>}
      {error && <Alert variant="error">{error}</Alert>}
      {!blockers.isLoading && !blockers.isError && blockers.data?.length === 0 && (
        <p className="text-sm text-paper-400">No open setup blockers</p>
      )}
      <ul className="space-y-3">
        {blockers.data?.map((blocker) => (
          <li className="space-y-2 border-t border-ink-600 pt-3" key={blocker.id}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 text-sm text-paper-200">
                <p>
                  {KIND_LABELS[blocker.kind]}
                  {blocker.subject && (
                    <>
                      : <span className="break-all font-mono">{blocker.subject}</span>
                    </>
                  )}
                </p>
                {blocker.step && <p className="text-xs text-paper-400">Step: {blocker.step}</p>}
              </div>
              <Button
                aria-label={`Dismiss ${KIND_LABELS[blocker.kind]} ${blocker.subject}`}
                disabled={disabled || dismiss.isPending}
                onClick={() => {
                  setError(null);
                  dismiss.mutate(blocker.id, {
                    onError: (err) => setError(errMsg(err, 'The blocker could not be dismissed')),
                  });
                }}
                size="sm"
                variant="ghost"
              >
                Dismiss
              </Button>
            </div>
            <p className="text-sm font-medium text-paper-100">{blocker.remedy}</p>
            <p className="text-xs text-paper-500">
              {blocker.occurrences} occurrence{blocker.occurrences === 1 ? '' : 's'} · Last seen{' '}
              <time dateTime={blocker.lastSeenAt}>
                {new Date(blocker.lastSeenAt).toLocaleString()}
              </time>
            </p>
            <details className="text-xs text-paper-400">
              <summary className="cursor-pointer">Detail</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all">
                {blocker.detail || 'No additional detail.'}
              </pre>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
