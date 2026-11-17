'use client';

import { useState } from 'react';
import { locationLabel, shortSha } from '@/components/harnessProfiles/profileDisplay';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  type MarketplaceSourceDto,
  useCheckMarketplace,
  useDeleteMarketplace,
  useMarketplaces,
  usePatchMarketplace,
} from '@/hooks/useMarketplaces';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';
import { AddMarketplaceModal } from './AddMarketplaceModal';
import { MarketplaceDetailModal } from './MarketplaceDetailModal';
import { STATUS_LABEL, STATUS_TONE } from './marketplaceDisplay';
import { ReviewMarketplaceUpdateModal } from './ReviewMarketplaceUpdateModal';

const COLUMNS: DataTableColumn<MarketplaceSourceDto>[] = [
  {
    cell: (s) => <span className="font-mono text-sm break-all">{locationLabel(s)}</span>,
    header: 'Marketplace',
    id: 'source',
    primary: true,
    secondary: (s) => <>ref {visibleText(s.ref)}</>,
  },
  {
    cell: (s) => (
      <span className="font-mono text-xs text-paper-400">
        <span title={s.pinnedSha}>{shortSha(s.pinnedSha)}</span>
        {' / '}
        <span title={s.latestSha ?? undefined}>{shortSha(s.latestSha)}</span>
      </span>
    ),
    header: 'Pinned / latest',
    id: 'pinned',
  },
  {
    cell: (s) => (
      <>
        <Badge dot tone={STATUS_TONE[s.status]}>
          {STATUS_LABEL[s.status]}
        </Badge>
        <div className="mt-1 text-xs text-paper-500" title={s.lastCheckedAt ?? undefined}>
          {s.lastCheckedAt ? `Checked ${formatDate(s.lastCheckedAt)}` : 'Never checked'}
        </div>
        {s.lastError && (
          <div className="mt-0.5 text-xs text-danger-400">{visibleText(s.lastError)}</div>
        )}
      </>
    ),
    header: 'Status',
    id: 'status',
  },
  {
    align: 'right',
    cell: (s) => <span className="tabular-nums text-paper-300">{s.profileCount}</span>,
    header: 'Plugins',
    id: 'profiles',
  },
];

/**
 * Marketplaces: repositories holding a plugin catalog, pinned to a commit. The sweep only flags
 * that the ref moved; an admin reviews the catalog at the newer commit and accepts it. Plugins
 * are approved from the catalog one at a time. ADMIN-only (the server enforces it too).
 */
export function MarketplacesTab() {
  const { data: sources, isLoading, isError, isFetching, error, refetch } = useMarketplaces();
  const check = useCheckMarketplace();
  const patch = usePatchMarketplace();
  const remove = useDeleteMarketplace();
  const [addOpen, setAddOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<MarketplaceSourceDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MarketplaceSourceDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);

  async function run(id: string, action: () => Promise<void>, failure: string) {
    setNotice(null);
    setBusyId(id);
    try {
      await action();
    } catch (err) {
      setNotice({ text: errMsg(err, failure), tone: 'error' });
    } finally {
      setBusyId(null);
    }
  }

  const checkNow = (s: MarketplaceSourceDto) =>
    run(
      s.id,
      async () => {
        const r = await check.mutateAsync(s.id);
        if (!r.recorded) {
          setNotice({
            text: 'Not recorded: the marketplace changed while it was being checked. Check again.',
            tone: 'info',
          });
        } else if (r.check.error) {
          setNotice({ text: visibleText(r.check.error), tone: 'info' });
        }
      },
      'Failed to check the marketplace'
    );

  const toggleStatus = (s: MarketplaceSourceDto) =>
    run(
      s.id,
      () =>
        patch
          .mutateAsync({ id: s.id, status: s.status === 'DISABLED' ? 'OK' : 'DISABLED' })
          .then(() => undefined),
      'Failed to update the marketplace'
    );

  return (
    <>
      <Card className="p-4 sm:p-6">
        <CardHeader>
          <CardTitle>Marketplaces</CardTitle>
          {sources && sources.length > 0 && (
            <Button onClick={() => setAddOpen(true)} variant="primary">
              <Icon name="plus" size={14} />
              Add marketplace
            </Button>
          )}
        </CardHeader>
        <p className="-mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-paper-400">
          Repositories that list Claude Code plugins in a <code>marketplace.json</code>, each pinned
          to a commit. A newer commit is only flagged; you review the catalog and accept it. A
          plugin from the catalog is approved on its own, after you read it.
        </p>
        {notice && (
          <Alert className="mb-4" variant={notice.tone === 'error' ? 'error' : 'info'}>
            {notice.text}
          </Alert>
        )}
        <QueryBoundary
          error={error}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="marketplaces"
          onRetry={() => void refetch()}
          rows={3}
        >
          {!sources?.length ? (
            <EmptyState
              action={
                <Button onClick={() => setAddOpen(true)} size="sm" variant="primary">
                  Add marketplace
                </Button>
              }
              bordered
              hint="Point at a GitHub repository with a .claude-plugin/marketplace.json to browse and approve its plugins."
              icon="github"
              title="No marketplaces yet"
            />
          ) : (
            <DataTable
              actions={(s) => (
                <>
                  {s.status === 'UPDATE_AVAILABLE' && (
                    <Button onClick={() => setReviewing(s)} size="sm" variant="primary">
                      Review update
                    </Button>
                  )}
                  <Button onClick={() => setDetailId(s.id)} size="sm">
                    Catalog
                  </Button>
                  <Button
                    disabled={busyId === s.id || s.status === 'DISABLED'}
                    onClick={() => checkNow(s)}
                    size="sm"
                  >
                    {busyId === s.id ? 'Working…' : 'Check now'}
                  </Button>
                  <ActionMenu
                    items={[
                      {
                        disabled: busyId === s.id,
                        icon: s.status === 'DISABLED' ? 'check' : 'close',
                        id: 'status',
                        label: s.status === 'DISABLED' ? 'Enable' : 'Disable',
                        onAction: () => void toggleStatus(s),
                      },
                      {
                        icon: 'trash',
                        id: 'delete',
                        label: 'Delete',
                        onAction: () => setDeleteTarget(s),
                        tone: 'danger',
                      },
                    ]}
                    label={`More actions for ${locationLabel(s)}`}
                  />
                </>
              )}
              columns={COLUMNS}
              density="compact"
              getRowId={(s) => s.id}
              revealActions={false}
              rows={sources}
            />
          )}
        </QueryBoundary>
      </Card>

      <AddMarketplaceModal onClose={() => setAddOpen(false)} open={addOpen} />
      <MarketplaceDetailModal id={detailId} onClose={() => setDetailId(null)} />
      <ReviewMarketplaceUpdateModal onClose={() => setReviewing(null)} source={reviewing} />
      <ConfirmModal
        confirmLabel="Delete marketplace"
        dangerous
        message={`Its ${deleteTarget?.profileCount ?? 0} approved plugin(s) are kept: they stay approved and bound, and no longer follow this marketplace.`}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await remove.mutateAsync(deleteTarget.id);
          }
        }}
        open={deleteTarget !== null}
        pendingLabel="Deleting…"
        title={`Delete marketplace "${deleteTarget ? locationLabel(deleteTarget) : ''}"?`}
      />
    </>
  );
}
