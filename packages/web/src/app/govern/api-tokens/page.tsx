'use client';

import { useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { useAdminRevokeToken, useAdminTokens } from '@/hooks/useAdmin';
import { errMsg } from '@/lib/errors';
import { navLabel } from '@/lib/navigation';
import { cn, formatDate } from '@/lib/utils';

function StatusChip({ status }: { status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' }) {
  return (
    <Badge
      dot={status === 'ACTIVE'}
      tone={status === 'ACTIVE' ? 'moss' : status === 'EXPIRED' ? 'amber' : 'muted'}
      variant={status === 'ACTIVE' ? 'text' : 'outline'}
    >
      {STATUS_LABELS[status]}
    </Badge>
  );
}

const PAGE_SIZE = 25;

type TokenStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

const STATUS_LABELS: Record<TokenStatus, string> = {
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
};

export default function GovernAccessTokensPage() {
  const {
    data: tokens,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useAdminTokens();
  const revokeToken = useAdminRevokeToken();
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [statusFilter, setStatusFilter] = useState<'' | TokenStatus>('');
  const [userFilter, setUserFilter] = useState('');
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');

  // Awaited so ConfirmModal keeps the dialog open and shows a failed revoke.
  const confirmRevoke = async () => {
    if (revokeTarget) {
      await revokeToken.mutateAsync(revokeTarget.id);
    }
  };

  const now = Date.now();
  const statusOf = (t: NonNullable<typeof tokens>[number]): TokenStatus =>
    t.revokedAt
      ? 'REVOKED'
      : t.expiresAt && new Date(t.expiresAt).getTime() < now
        ? 'EXPIRED'
        : 'ACTIVE';
  const all = tokens ?? [];
  const activeCount = all.filter((t) => statusOf(t) === 'ACTIVE').length;
  const userOptions = [...new Set(all.map((t) => t.user.email))].sort();
  const query = search.trim().toLowerCase();
  const rows = all.filter(
    (t) =>
      (!statusFilter || statusOf(t) === statusFilter) &&
      (!userFilter || t.user.email === userFilter) &&
      (!query || t.name.toLowerCase().includes(query) || t.prefix.toLowerCase().includes(query))
  );
  const pageStart = Math.min(page * PAGE_SIZE, Math.max(0, rows.length - 1));
  const pageRows = rows.slice(pageStart, pageStart + PAGE_SIZE);

  const header = (
    <PageHeader
      subtitle="Platform admins can view and revoke any user's personal access token. Token values are never stored — only the non-secret prefix is shown."
      title={navLabel('/govern/api-tokens')}
    />
  );

  if (isLoading || isError) {
    return (
      <div className="space-y-6">
        {header}
        <QueryBoundary
          error={loadError}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="tokens"
          loading={
            <Card>
              <SkeletonRows rows={5} />
            </Card>
          }
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const filtering = statusFilter !== '' || userFilter !== '' || query !== '';
  const clearFilters = () => {
    setStatusFilter('');
    setUserFilter('');
    setSearch('');
    setPage(0);
  };

  return (
    <div className="space-y-6">
      {header}

      {revokeToken.isError && (
        <Alert>Revoke failed: {errMsg(revokeToken.error, 'unknown error')}</Alert>
      )}

      <Card className="fade-up stagger-1 p-4 sm:p-6">
        <Toolbar
          end={
            <span className="text-xs text-paper-500 tabular-nums">
              {filtering
                ? `${rows.length} of ${all.length} tokens`
                : `${activeCount} active · ${all.length} total`}
            </span>
          }
        >
          <SearchInput
            label="Search tokens"
            onChange={(v) => {
              setSearch(v);
              setPage(0);
            }}
            placeholder="Search name or prefix…"
            value={search}
          />
          <Select
            aria-label="Filter by status"
            className="h-8 w-full text-[13px] sm:w-40"
            onChange={(v) => {
              setStatusFilter(v as '' | TokenStatus);
              setPage(0);
            }}
            options={[
              { label: 'All statuses', value: '' },
              ...(Object.keys(STATUS_LABELS) as TokenStatus[]).map((v) => ({
                label: STATUS_LABELS[v],
                value: v,
              })),
            ]}
            value={statusFilter}
          />
          <Select
            aria-label="Filter by user"
            className="h-8 w-full text-[13px] sm:w-56"
            onChange={(v) => {
              setUserFilter(v);
              setPage(0);
            }}
            options={[
              { label: 'All users', value: '' },
              ...userOptions.map((e) => ({ label: e, value: e })),
            ]}
            value={userFilter}
          />
          {filtering && (
            <Button onClick={clearFilters} size="sm" variant="ghost">
              Clear filters
            </Button>
          )}
        </Toolbar>

        <Table stacked>
          <THead>
            <Th className="pl-0" variant="plain">
              Token
            </Th>
            <Th variant="plain">Owner</Th>
            <Th variant="plain">Status</Th>
            <Th variant="plain">Last used</Th>
            <Th variant="plain">Created</Th>
            <Th variant="plain">Expires</Th>
            <Th className="pr-0" variant="plain">
              <span className="sr-only">Actions</span>
            </Th>
          </THead>
          <tbody>
            {pageRows.map((t) => {
              const status = statusOf(t);
              return (
                <TRow hover key={t.id}>
                  <Td className="py-3 pr-4" primary>
                    <div
                      className={cn(
                        'truncate font-medium',
                        status === 'ACTIVE' ? 'text-paper-100' : 'text-paper-400'
                      )}
                    >
                      {t.name}
                    </div>
                    <div className="mt-0.5 font-mono text-xs font-normal text-paper-500">
                      {t.prefix}…
                    </div>
                  </Td>
                  <Td className="px-4 py-3 text-[13px] text-paper-300" label="Owner">
                    {t.user.email}
                  </Td>
                  <Td className="px-4 py-3" label="Status">
                    <StatusChip status={status} />
                  </Td>
                  <Td className="px-4 py-3 text-[13px] text-paper-300" label="Last used">
                    {t.lastUsedAt ? (
                      <RelativeTime value={t.lastUsedAt} />
                    ) : (
                      <span className="text-paper-500">Never</span>
                    )}
                  </Td>
                  <Td className="px-4 py-3 text-[13px] text-paper-400" label="Created">
                    <RelativeTime value={t.createdAt} />
                  </Td>
                  <Td className="px-4 py-3 text-[13px] text-paper-400" label="Expires">
                    {t.expiresAt ? (
                      <span className="whitespace-nowrap" title={formatDate(t.expiresAt)}>
                        {formatDate(t.expiresAt)}
                      </span>
                    ) : (
                      <span className="text-paper-500">Never</span>
                    )}
                  </Td>
                  <Td align="right" className="py-3 pl-4">
                    {!t.revokedAt && (
                      <ActionMenu
                        items={[
                          {
                            disabled: revokeToken.isPending,
                            icon: 'lock',
                            id: 'revoke',
                            label: 'Revoke token',
                            onAction: () => setRevokeTarget({ id: t.id, name: t.name }),
                            tone: 'danger',
                          },
                        ]}
                        label={`Actions for token ${t.name}`}
                      />
                    )}
                  </Td>
                </TRow>
              );
            })}
            {rows.length === 0 && (
              <TableStatusRow colSpan={7}>
                {all.length === 0 ? (
                  <EmptyState
                    hint="People create personal access tokens under Settings → API tokens, for the CLI and CI."
                    icon="key"
                    title="No tokens issued yet"
                  />
                ) : (
                  <EmptyState
                    action={
                      <Button onClick={clearFilters} size="sm">
                        Clear filters
                      </Button>
                    }
                    hint="Try a different status, user or search."
                    icon="search"
                    title="No tokens match these filters"
                  />
                )}
              </TableStatusRow>
            )}
          </tbody>
        </Table>
        {rows.length > PAGE_SIZE && (
          <div className="mt-4 border-t border-ink-600 pt-4">
            <Pagination
              hasNext={pageStart + PAGE_SIZE < rows.length}
              hasPrev={pageStart > 0}
              onNext={() => setPage(page + 1)}
              onPrev={() => setPage(Math.max(0, page - 1))}
              rangeEnd={Math.min(pageStart + PAGE_SIZE, rows.length)}
              rangeStart={pageStart + 1}
              total={rows.length}
            />
          </div>
        )}
      </Card>

      <ConfirmModal
        confirmLabel="Revoke"
        dangerous
        message={`Revoke the token "${revokeTarget?.name}"? Anything using it — the CLI, a CI job — stops authenticating at once. This cannot be undone.`}
        onClose={() => setRevokeTarget(null)}
        onConfirm={confirmRevoke}
        open={revokeTarget !== null}
        title="Revoke access token?"
      />
    </div>
  );
}
