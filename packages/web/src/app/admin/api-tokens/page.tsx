'use client';

import { useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Select } from '@/components/ui/Select';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { useAdminRevokeToken, useAdminTokens } from '@/hooks/useAdmin';
import { useDataTableSort } from '@/hooks/useDataTableSort';
import { errMsg } from '@/lib/errors';
import { navLabel } from '@/lib/navigation';
import { formatDate } from '@/lib/utils';

function StatusChip({ status }: { status: 'ACTIVE' | 'EXPIRED' | 'REVOKED' }) {
  return (
    <Badge
      dot={status === 'ACTIVE'}
      tone={status === 'ACTIVE' ? 'success' : status === 'EXPIRED' ? 'warning' : 'muted'}
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

type Token = NonNullable<ReturnType<typeof useAdminTokens>['data']>[number];

const TOKEN_SORT_KEYS = {
  created: (t: Token) => new Date(t.createdAt).getTime(),
  // A token that was never used sorts last.
  lastUsed: (t: Token) => (t.lastUsedAt ? new Date(t.lastUsedAt).getTime() : null),
  name: (t: Token) => t.name.toLowerCase(),
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
  const { onSortChange, sort, sortRows } = useDataTableSort<Token>(TOKEN_SORT_KEYS);

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
  // A service principal's token has no user; it is filtered as its principal.
  const ownerLabel = (t: (typeof all)[number]) =>
    t.user
      ? t.user.email
      : t.servicePrincipal
        ? `${t.servicePrincipal.name} (service · ${t.servicePrincipal.team.name})`
        : '—';
  const userOptions = [...new Set(all.map(ownerLabel))].sort();
  const query = search.trim().toLowerCase();
  const filtered = all.filter(
    (t) =>
      (!statusFilter || statusOf(t) === statusFilter) &&
      (!userFilter || ownerLabel(t) === userFilter) &&
      (!query || t.name.toLowerCase().includes(query) || t.prefix.toLowerCase().includes(query))
  );
  const rows = sortRows(filtered);
  const pageStart = Math.min(page * PAGE_SIZE, Math.max(0, rows.length - 1));
  const pageRows = rows.slice(pageStart, pageStart + PAGE_SIZE);

  const header = (
    <PageHeader
      help={<p>Token values are never stored — only the non-secret prefix is shown.</p>}
      subtitle="Platform admins can view and revoke any API token: people's personal access tokens and teams' service principal tokens."
      title={navLabel('/admin/api-tokens')}
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
              <SkeletonRows label="API tokens" rows={5} />
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
            className="h-8 w-full text-sm sm:w-40"
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
            aria-label="Filter by owner"
            className="h-8 w-full text-sm sm:w-56"
            onChange={(v) => {
              setUserFilter(v);
              setPage(0);
            }}
            options={[
              { label: 'All owners', value: '' },
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

        <div className="-mx-4">
          <DataTable
            actions={(t) =>
              t.revokedAt ? null : (
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
              )
            }
            className="max-sm:px-4"
            columns={[
              {
                cell: (t) => (
                  <span className={statusOf(t) === 'ACTIVE' ? undefined : 'text-paper-400'}>
                    {t.name}
                  </span>
                ),
                header: 'Token',
                id: 'name',
                primary: true,
                secondary: (t) => <span className="font-mono">{t.prefix}…</span>,
                sortable: true,
              },
              {
                cell: (t) =>
                  t.user ? (
                    <span className="text-paper-300">{t.user.email}</span>
                  ) : t.servicePrincipal ? (
                    <div className="text-paper-300">
                      <div>{t.servicePrincipal.name}</div>
                      <div className="mt-0.5 text-xs text-paper-500">
                        Service principal · {t.servicePrincipal.team.name} ·{' '}
                        <span className="font-mono">{t.scopes.join(' ')}</span>
                      </div>
                    </div>
                  ) : (
                    '—'
                  ),
                header: 'Owner',
                id: 'owner',
              },
              { cell: (t) => <StatusChip status={statusOf(t)} />, header: 'Status', id: 'status' },
              {
                cell: (t) =>
                  t.lastUsedAt ? (
                    <span className="text-paper-300">
                      <RelativeTime value={t.lastUsedAt} />
                    </span>
                  ) : (
                    <span className="text-paper-500">Never</span>
                  ),
                header: 'Last used',
                id: 'lastUsed',
                sortable: true,
              },
              {
                cell: (t) => (
                  <span className="text-paper-400">
                    <RelativeTime value={t.createdAt} />
                  </span>
                ),
                header: 'Created',
                id: 'created',
                sortable: true,
              },
              {
                cell: (t) =>
                  t.expiresAt ? (
                    <span
                      className="whitespace-nowrap text-paper-400"
                      title={formatDate(t.expiresAt)}
                    >
                      {formatDate(t.expiresAt)}
                    </span>
                  ) : (
                    <span className="text-paper-500">Never</span>
                  ),
                header: 'Expires',
                id: 'expires',
              },
            ]}
            empty={
              all.length === 0 ? (
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
              )
            }
            getRowId={(t) => t.id}
            onSortChange={onSortChange}
            revealActions={false}
            rows={pageRows}
            sort={sort}
          />
        </div>
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
