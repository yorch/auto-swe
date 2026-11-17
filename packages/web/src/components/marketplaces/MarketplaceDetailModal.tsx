'use client';

import { useState } from 'react';
import { locationLabel, shortSha } from '@/components/harnessProfiles/profileDisplay';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { useMarketplace } from '@/hooks/useMarketplaces';
import { visibleText } from '@/lib/visibleText';
import { CatalogTable } from './CatalogTable';
import { EntryApproveModal } from './EntryApproveModal';
import { STATUS_LABEL, STATUS_TONE } from './marketplaceDisplay';

/** One marketplace: its pin and its catalog at that pin, with the approve flow per entry. */
export function MarketplaceDetailModal({
  id,
  onClose,
}: {
  id: string | null;
  onClose: () => void;
}) {
  const { data, isLoading, isError, isFetching, error, refetch } = useMarketplace(id);
  const [approving, setApproving] = useState<string | null>(null);
  return (
    <>
      <Modal
        onClose={onClose}
        open={id !== null && approving === null}
        size="lg"
        subtitle={data ? locationLabel(data) : undefined}
        title={data?.catalog ? visibleText(data.catalog.name) : 'Marketplace'}
      >
        <QueryBoundary
          error={error}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="marketplace"
          onRetry={() => void refetch()}
          rows={3}
        >
          {data && (
            <div className="space-y-4">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-paper-500">Pinned</dt>
                <dd className="font-mono text-xs text-paper-300" title={data.pinnedSha}>
                  {shortSha(data.pinnedSha)} @ {visibleText(data.ref)}
                </dd>
                <dt className="text-paper-500">Status</dt>
                <dd>
                  <Badge dot tone={STATUS_TONE[data.status]}>
                    {STATUS_LABEL[data.status]}
                  </Badge>
                </dd>
              </dl>
              {data.catalogError && <Alert variant="error">{visibleText(data.catalogError)}</Alert>}
              {data.status === 'DISABLED' && (
                <Alert announce={false} variant="info">
                  This marketplace is disabled; enable it to approve plugins from it.
                </Alert>
              )}
              {data.catalog && (
                <CatalogTable
                  entries={data.catalog.entries}
                  onApprove={data.status === 'DISABLED' ? undefined : (e) => setApproving(e.name)}
                />
              )}
            </div>
          )}
        </QueryBoundary>
      </Modal>
      {id && (
        <EntryApproveModal
          entry={approving}
          marketplaceId={id}
          onClose={() => setApproving(null)}
        />
      )}
    </>
  );
}
