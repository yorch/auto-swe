'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { useUpdateRepository } from '@/hooks/useRepositories';
import { connectionLabel } from '@/lib/connectionDisplay';

/**
 * Deactivate or reactivate a connection, saying what it does first. Deactivating refuses new
 * work requests on the connection, so the dialog names the runs already in flight; it is the
 * same change as the Active switch in the edit form, one step instead of a form save.
 */
export function ToggleConnectionActiveModal({
  onClose,
  onDone,
  repo,
}: {
  onClose: () => void;
  /** Called after the change is saved, with a sentence for a status message. */
  onDone?: (message: string) => void;
  repo: RepositorySummary;
}) {
  const update = useUpdateRepository(repo.id);
  const label = connectionLabel(repo);
  const deactivating = repo.isActive;
  const active = repo._count?.activeWorkflows ?? 0;
  return (
    <ConfirmModal
      confirmLabel={deactivating ? 'Deactivate' : 'Reactivate'}
      dangerous={deactivating}
      message={
        deactivating ? (
          <>
            <p>
              Deactivate {label}? It stops accepting new work requests, and any pull request the
              platform set to auto-merge on it is disarmed.
            </p>
            {active > 0 && (
              <p className="mt-2 text-warning-400">
                {active} active workflow{active === 1 ? '' : 's'} use{active === 1 ? 's' : ''} this
                connection. Check them before you deactivate.
              </p>
            )}
            <p className="mt-2">You can reactivate it at any time.</p>
          </>
        ) : (
          <p>Reactivate {label}? It accepts new work requests again.</p>
        )
      }
      onClose={onClose}
      onConfirm={async () => {
        await update.mutateAsync({ isActive: !repo.isActive });
        onDone?.(deactivating ? `${label} deactivated.` : `${label} reactivated.`);
      }}
      open
      pendingLabel={deactivating ? 'Deactivating…' : 'Reactivating…'}
      title={deactivating ? 'Deactivate this connection?' : 'Reactivate this connection?'}
    />
  );
}
