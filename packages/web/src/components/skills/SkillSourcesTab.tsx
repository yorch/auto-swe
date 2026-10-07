'use client';

import { useState } from 'react';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import {
  type SkillSource,
  type SourceStatus,
  useCheckSource,
  useDeleteSource,
  usePatchSource,
  useSkillSources,
} from '@/hooks/useSkillSources';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';
import { AddSourceModal } from './AddSourceModal';
import { InstallSkillsModal } from './InstallSkillsModal';
import { ReviewUpdateModal } from './ReviewUpdateModal';
import { shortSha, sourceLabel } from './sourceDisplay';

const STATUS_TONE: Record<SourceStatus, BadgeTone> = {
  DISABLED: 'muted',
  ERROR: 'brick',
  OK: 'moss',
  UPDATE_AVAILABLE: 'amber',
};

const STATUS_LABEL: Record<SourceStatus, string> = {
  DISABLED: 'Disabled',
  ERROR: 'Error',
  OK: 'Up to date',
  UPDATE_AVAILABLE: 'Update available',
};

const SCRIPT_MODE_LABEL = { REJECT: 'Reject scripts', TEXT_ONLY: 'Text only' } as const;

/**
 * Skills imported from an external GitHub repository, pinned to a commit. The
 * sweep only flags that the ref moved; an admin reviews the per-skill diff and
 * accepts it. ADMIN-only (the server enforces it too).
 */
export function SkillSourcesTab() {
  const { data: sources, isLoading, isError, isFetching, error, refetch } = useSkillSources();
  const check = useCheckSource();
  const patch = usePatchSource();
  const remove = useDeleteSource();
  const [addOpen, setAddOpen] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [installFor, setInstallFor] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillSource | null>(null);
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

  const checkNow = (s: SkillSource) =>
    run(
      s.id,
      async () => {
        const r = await check.mutateAsync(s.id);
        if (!r.recorded) {
          setNotice({
            text: 'Not recorded: the source changed while it was being checked. Check again.',
            tone: 'info',
          });
        } else if (r.check.error) {
          setNotice({ text: r.check.error, tone: 'info' });
        }
      },
      'Failed to check the source'
    );

  const toggleStatus = (s: SkillSource) =>
    run(
      s.id,
      () =>
        patch
          .mutateAsync({ id: s.id, status: s.status === 'DISABLED' ? 'OK' : 'DISABLED' })
          .then(() => undefined),
      'Failed to update the source'
    );

  const toggleScripts = (s: SkillSource) =>
    run(
      s.id,
      () =>
        patch
          .mutateAsync({
            id: s.id,
            scriptMode: s.scriptMode === 'REJECT' ? 'TEXT_ONLY' : 'REJECT',
          })
          .then(() => undefined),
      'Failed to update the source'
    );

  return (
    <>
      <Card className="p-4 sm:p-6">
        <CardHeader>
          <CardTitle eyebrow="GitHub repositories">External sources</CardTitle>
          {sources && sources.length > 0 && (
            <Button onClick={() => setAddOpen(true)} variant="primary">
              <Icon name="plus" size={14} />
              Add source
            </Button>
          )}
        </CardHeader>
        <p className="-mt-2 mb-4 max-w-3xl text-[13px] leading-relaxed text-paper-400">
          Skills imported from a GitHub repository, each pinned to a commit. A newer commit is only
          flagged; you review the per-skill diff and accept it. Imported skills start unverified.
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
          label="skill sources"
          loading={<SkeletonRows rows={3} />}
          onRetry={() => void refetch()}
        >
          {!sources?.length ? (
            <EmptyState
              action={
                <Button onClick={() => setAddOpen(true)} size="sm" variant="primary">
                  Add source
                </Button>
              }
              bordered
              hint="Point at a GitHub repository of skill files to import them, pinned to a commit."
              icon="github"
              title="No external sources yet"
            />
          ) : (
            <Table stacked>
              <THead>
                <Th className="pl-0" variant="plain">
                  Source
                </Th>
                <Th variant="plain">Pinned / latest</Th>
                <Th variant="plain">Status</Th>
                <Th variant="plain">Scripts</Th>
                <Th className="pr-0" variant="plain">
                  <span className="sr-only">Actions</span>
                </Th>
              </THead>
              <tbody>
                {sources.map((s) => {
                  const label = sourceLabel(s);
                  return (
                    <TRow key={s.id}>
                      <Td className="py-2.5 pr-4" primary>
                        <div className="font-mono text-[13px] font-medium break-all text-paper-100">
                          {label}
                        </div>
                        <div className="mt-0.5 text-xs text-paper-500">
                          ref {visibleText(s.ref)} · {s.skillCount} skill
                          {s.skillCount === 1 ? '' : 's'}
                        </div>
                      </Td>
                      <Td
                        className="px-4 py-2.5 font-mono text-xs text-paper-400"
                        label="Pinned / latest"
                      >
                        <span title={s.pinnedSha}>{shortSha(s.pinnedSha)}</span>
                        {' / '}
                        <span title={s.latestSha ?? undefined}>{shortSha(s.latestSha)}</span>
                      </Td>
                      <Td className="px-4 py-2.5" label="Status">
                        <Badge dot tone={STATUS_TONE[s.status]}>
                          {STATUS_LABEL[s.status]}
                        </Badge>
                        <div
                          className="mt-1 text-xs text-paper-500"
                          title={s.lastCheckedAt ?? undefined}
                        >
                          {s.lastCheckedAt
                            ? `Checked ${formatDate(s.lastCheckedAt)}`
                            : 'Never checked'}
                        </div>
                        {s.lastError && (
                          <div className="mt-0.5 text-xs text-brick-400">
                            {visibleText(s.lastError)}
                          </div>
                        )}
                      </Td>
                      <Td className="px-4 py-2.5 text-xs text-paper-300" label="Scripts">
                        {SCRIPT_MODE_LABEL[s.scriptMode]}
                      </Td>
                      <Td align="right" className="py-2.5 pl-4">
                        <div className="flex items-center justify-end gap-1">
                          {s.status === 'UPDATE_AVAILABLE' && (
                            <Button onClick={() => setReviewId(s.id)} size="sm" variant="primary">
                              Review update
                            </Button>
                          )}
                          <Button
                            disabled={busyId === s.id || s.status === 'DISABLED'}
                            onClick={() => checkNow(s)}
                            size="sm"
                          >
                            {busyId === s.id ? 'Working…' : 'Check now'}
                          </Button>
                          <ActionMenu
                            items={[
                              ...(s.status === 'OK' || s.status === 'UPDATE_AVAILABLE'
                                ? [
                                    {
                                      icon: 'plus' as const,
                                      id: 'install',
                                      label: 'Install more skills',
                                      onAction: () => setInstallFor(s.id),
                                    },
                                  ]
                                : []),
                              {
                                disabled: busyId === s.id,
                                icon: s.status === 'DISABLED' ? 'check' : 'close',
                                id: 'status',
                                label: s.status === 'DISABLED' ? 'Enable' : 'Disable',
                                onAction: () => void toggleStatus(s),
                              },
                              {
                                disabled: busyId === s.id,
                                icon: 'security',
                                id: 'scripts',
                                label:
                                  s.scriptMode === 'REJECT' ? 'Allow text files' : 'Reject scripts',
                                onAction: () => void toggleScripts(s),
                              },
                              {
                                icon: 'trash',
                                id: 'delete',
                                label: 'Delete',
                                onAction: () => setDeleteTarget(s),
                                tone: 'danger',
                              },
                            ]}
                            label={`More actions for ${label}`}
                          />
                        </div>
                      </Td>
                    </TRow>
                  );
                })}
              </tbody>
            </Table>
          )}
        </QueryBoundary>
      </Card>

      <AddSourceModal onClose={() => setAddOpen(false)} open={addOpen} />
      <ReviewUpdateModal onClose={() => setReviewId(null)} sourceId={reviewId} />
      <InstallSkillsModal onClose={() => setInstallFor(null)} sourceId={installFor} />
      <ConfirmModal
        confirmLabel="Delete source"
        dangerous
        message={`Its ${deleteTarget?.skillCount ?? 0} skill(s) are detached and kept as ordinary custom skills: they stay installed and assigned, and no longer receive updates from this repository.`}
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await remove.mutateAsync(deleteTarget.id);
          }
        }}
        open={deleteTarget !== null}
        pendingLabel="Deleting…"
        title={`Delete source "${deleteTarget ? sourceLabel(deleteTarget) : ''}"?`}
      />
    </>
  );
}
