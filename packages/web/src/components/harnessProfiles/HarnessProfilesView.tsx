'use client';

import { useState } from 'react';
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
  type HarnessProfileSummary,
  useCheckProfile,
  useHarnessProfiles,
  usePatchProfile,
  useProfileUsage,
} from '@/hooks/useHarnessProfiles';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';
import { AddProfileModal } from './AddProfileModal';
import { HooksBadge } from './HooksBadge';
import { ProfileDetailModal } from './ProfileDetailModal';
import { locationLabel, shortSha, TRACK_LABEL, TRACK_TONE } from './profileDisplay';

type Usage = ReturnType<typeof useProfileUsage>;

const columns = (usage: Usage): DataTableColumn<HarnessProfileSummary>[] => [
  {
    cell: (p) => <span className="font-medium">{visibleText(p.name)}</span>,
    header: 'Plugin',
    id: 'name',
    primary: true,
    secondary: (p) => visibleText(p.description),
  },
  {
    cell: (p) =>
      p.marketplaceSourceId ? (
        <div>
          <Badge tone="accent2">Marketplace</Badge>
          <div className="mt-1 font-mono text-xs break-all">
            {visibleText(p.marketplaceEntry ?? '')}
          </div>
        </div>
      ) : (
        <div>
          <Badge tone="neutral">Folder</Badge>
          <div className="mt-1 font-mono text-xs break-all">{locationLabel(p)}</div>
        </div>
      ),
    header: 'Source',
    id: 'source',
    secondary: (p) => <>ref {visibleText(p.ref)}</>,
  },
  {
    cell: (p) =>
      p.latest ? (
        <span className="font-mono text-xs text-paper-300">
          v{p.latest.version} ·{' '}
          <span title={p.latest.commitSha}>{shortSha(p.latest.commitSha)}</span>
          <div className="text-paper-500">
            {p.latest.fileCount} file{p.latest.fileCount === 1 ? '' : 's'}
            {p.latest.warnings.length > 0 ? ` · ${p.latest.warnings.length} warning(s)` : ''}
          </div>
        </span>
      ) : (
        <span className="text-xs text-paper-500">no version</span>
      ),
    header: 'Latest version',
    id: 'latest',
  },
  {
    cell: (p) => <HooksBadge enabled={p.hooksEnabled} />,
    header: 'Hooks',
    id: 'hooks',
  },
  {
    cell: (p) => (
      <>
        <Badge dot tone={TRACK_TONE[p.trackStatus]}>
          {TRACK_LABEL[p.trackStatus]}
        </Badge>
        <div className="mt-1 text-xs text-paper-500" title={p.lastCheckedAt ?? undefined}>
          {p.lastCheckedAt ? `Checked ${formatDate(p.lastCheckedAt)}` : 'Never checked'}
        </div>
        {p.lastError && (
          <div className="mt-0.5 text-xs text-danger-400">{visibleText(p.lastError)}</div>
        )}
      </>
    ),
    header: 'Tracking',
    id: 'tracking',
  },
  {
    align: 'right',
    cell: (p) => (
      <span className="tabular-nums text-paper-300">{usage.get(p.name)?.enabledTeams ?? '…'}</span>
    ),
    header: 'Teams',
    id: 'teams',
  },
  {
    align: 'right',
    cell: (p) => {
      const n = usage.get(p.name)?.stranded;
      return n ? (
        <Badge dot tone="danger">
          {n} stranded
        </Badge>
      ) : (
        <span className="tabular-nums text-paper-500">{n === undefined ? '…' : '0'}</span>
      );
    },
    header: 'Stranded agents',
    id: 'stranded',
  },
  {
    cell: (p) => (
      <>
        <Badge dot tone={p.status === 'OK' ? 'success' : 'muted'}>
          {p.status === 'OK' ? 'Enabled' : 'Disabled'}
        </Badge>
        <div className="mt-1 text-xs text-paper-500">Updated {formatDate(p.updatedAt)}</div>
      </>
    ),
    header: 'Status',
    id: 'status',
  },
];

/**
 * The Plugins tab (ADMIN): approved Claude Code plugins read from a repository at an exact commit,
 * from a folder or a marketplace. Plugins are never deleted (an agent may name one), only disabled.
 */
export function HarnessProfilesView() {
  const { data: profiles, isLoading, isError, isFetching, error, refetch } = useHarnessProfiles();
  const patch = usePatchProfile();
  const checkProfile = useCheckProfile();
  const usage = useProfileUsage((profiles ?? []).map((p) => p.name));
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [disableTarget, setDisableTarget] = useState<HarnessProfileSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function enable(p: HarnessProfileSummary) {
    setNotice(null);
    try {
      await patch.mutateAsync({ name: p.name, status: 'OK' });
    } catch (err) {
      setNotice(errMsg(err, 'Failed to enable the plugin'));
    }
  }

  async function checkNow(p: HarnessProfileSummary) {
    setNotice(null);
    try {
      const r = await checkProfile.mutateAsync(p.name);
      if (!r.recorded) {
        setNotice('Not recorded: the plugin changed while it was being checked. Check again.');
      } else if (r.check.error) {
        setNotice(visibleText(r.check.error));
      }
    } catch (err) {
      setNotice(errMsg(err, 'Failed to check the plugin'));
    }
  }

  const addButton = (
    <Button onClick={() => setAddOpen(true)} variant="primary">
      <Icon name="plus" size={14} />
      Add from folder
    </Button>
  );

  return (
    <>
      <Card className="p-4 sm:p-6">
        <CardHeader>
          <CardTitle>Approved plugins</CardTitle>
          {profiles && profiles.length > 0 && addButton}
        </CardHeader>
        <p className="-mt-2 mb-4 max-w-3xl text-sm leading-relaxed text-paper-400">
          A plugin's hooks and scripts run commands inside the run container, so approving one is a
          platform decision. You read the exact commit, its warnings and its files before approving;
          the stored snapshot is what runs, even if the repository later changes. Teams enable the
          plugins you approve before their agents can bind them.
        </p>
        {notice && (
          <Alert className="mb-4" variant="error">
            {notice}
          </Alert>
        )}
        <QueryBoundary
          error={error}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="plugins"
          onRetry={() => void refetch()}
          rows={3}
        >
          {!profiles?.length ? (
            <EmptyState
              action={
                <Button onClick={() => setAddOpen(true)} size="sm" variant="primary">
                  Add from folder
                </Button>
              }
              bordered
              hint="Approve a plugin from a marketplace (Marketplaces tab), or point at a folder of a GitHub repository that holds profile.json."
              icon="github"
              title="No plugins yet"
            />
          ) : (
            <DataTable
              actions={(p) => (
                <>
                  <Button onClick={() => setDetail(p.name)} size="sm">
                    Details
                  </Button>
                  <ActionMenu
                    items={[
                      {
                        disabled: checkProfile.isPending || p.status !== 'OK',
                        icon: 'refresh',
                        id: 'check',
                        label: 'Check now',
                        onAction: () => void checkNow(p),
                      },
                      p.status === 'OK'
                        ? {
                            icon: 'close',
                            id: 'disable',
                            label: 'Disable',
                            onAction: () => setDisableTarget(p),
                          }
                        : {
                            disabled: patch.isPending,
                            icon: 'check',
                            id: 'enable',
                            label: 'Enable',
                            onAction: () => void enable(p),
                          },
                    ]}
                    label={`More actions for ${visibleText(p.name)}`}
                  />
                </>
              )}
              columns={columns(usage)}
              density="compact"
              getRowId={(p) => p.id}
              revealActions={false}
              rows={profiles}
            />
          )}
        </QueryBoundary>
      </Card>

      <AddProfileModal onClose={() => setAddOpen(false)} open={addOpen} />
      <ProfileDetailModal name={detail} onClose={() => setDetail(null)} />
      <ConfirmModal
        confirmLabel="Disable plugin"
        dangerous
        message="A disabled profile takes no new version and cannot be newly bound to an agent. Runs that already pinned a version keep using it; cancel those runs to stop them. Agents already bound to it fail closed on new runs."
        onClose={() => setDisableTarget(null)}
        onConfirm={async () => {
          if (disableTarget) {
            await patch.mutateAsync({ name: disableTarget.name, status: 'DISABLED' });
          }
        }}
        open={disableTarget !== null}
        pendingLabel="Disabling…"
        title={`Disable "${disableTarget ? visibleText(disableTarget.name) : ''}"?`}
      />
    </>
  );
}
