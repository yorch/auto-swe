'use client';

import { useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  type HarnessProfileSummary,
  useHarnessProfiles,
  usePatchProfile,
} from '@/hooks/useHarnessProfiles';
import { errMsg } from '@/lib/errors';
import { HELP_LINKS } from '@/lib/helpLinks';
import { formatDate } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';
import { AddProfileModal } from './AddProfileModal';
import { ProfileDetailModal } from './ProfileDetailModal';
import { locationLabel, shortSha } from './profileDisplay';

const COLUMNS: DataTableColumn<HarnessProfileSummary>[] = [
  {
    cell: (p) => <span className="font-medium">{visibleText(p.name)}</span>,
    header: 'Profile',
    id: 'name',
    primary: true,
    secondary: (p) => visibleText(p.description),
  },
  {
    cell: (p) => <span className="font-mono text-xs break-all">{locationLabel(p)}</span>,
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
 * ADMIN page for harness profiles: approved bundles of Claude Code plugins and instructions read
 * from a repository at an exact commit. Profiles are never deleted (an agent may name one), only
 * disabled.
 */
export function HarnessProfilesView() {
  const { data: profiles, isLoading, isError, isFetching, error, refetch } = useHarnessProfiles();
  const patch = usePatchProfile();
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [disableTarget, setDisableTarget] = useState<HarnessProfileSummary | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function enable(p: HarnessProfileSummary) {
    setNotice(null);
    try {
      await patch.mutateAsync({ name: p.name, status: 'OK' });
    } catch (err) {
      setNotice(errMsg(err, 'Failed to enable the profile'));
    }
  }

  const addButton = (
    <Button onClick={() => setAddOpen(true)} variant="primary">
      <Icon name="plus" size={14} />
      Add profile
    </Button>
  );

  return (
    <>
      <PageHeader
        actions={profiles && profiles.length > 0 ? addButton : undefined}
        help="A profile's hooks and scripts run commands inside the run container, so approving one is a platform decision. You read the exact commit, its warnings and its files before approving; the stored snapshot is what runs, even if the repository later changes."
        learnMore={HELP_LINKS.harnessProfiles}
        subtitle="Approved bundles of Claude Code plugins and instructions, bound to agents by name."
        title="Harness profiles"
      />
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
        label="harness profiles"
        onRetry={() => void refetch()}
        rows={3}
      >
        {!profiles?.length ? (
          <EmptyState
            action={
              <Button onClick={() => setAddOpen(true)} size="sm" variant="primary">
                Add profile
              </Button>
            }
            bordered
            hint="Point at a folder of a GitHub repository that holds profile.json to review and approve it."
            icon="github"
            title="No harness profiles yet"
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
            columns={COLUMNS}
            density="compact"
            getRowId={(p) => p.id}
            revealActions={false}
            rows={profiles}
          />
        )}
      </QueryBoundary>

      <AddProfileModal onClose={() => setAddOpen(false)} open={addOpen} />
      <ProfileDetailModal name={detail} onClose={() => setDetail(null)} />
      <ConfirmModal
        confirmLabel="Disable profile"
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
