'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
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

const SCRIPT_MODE_LABEL = { REJECT: 'reject scripts', TEXT_ONLY: 'text only' } as const;

/**
 * Skills imported from an external GitHub repository, pinned to a commit. The
 * sweep only flags that the ref moved; an admin reviews the per-skill diff and
 * accepts it. ADMIN-only (the server enforces it too).
 */
export function SkillSourcesTab() {
  const { data: sources, isLoading, isError, error } = useSkillSources();
  const check = useCheckSource();
  const patch = usePatchSource();
  const remove = useDeleteSource();
  const [addOpen, setAddOpen] = useState(false);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [installFor, setInstallFor] = useState<SkillSource | null>(null);
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

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>External sources</CardTitle>
          <Button onClick={() => setAddOpen(true)} variant="primary">
            Add source
          </Button>
        </CardHeader>
        <p className="mb-3 text-xs text-paper-500">
          Skills imported from a GitHub repository, each pinned to a commit. A newer commit is only
          flagged; you review the per-skill diff and accept it. Imported skills start unverified.
        </p>
        {notice && (
          <Alert variant={notice.tone === 'error' ? 'error' : 'info'}>{notice.text}</Alert>
        )}
        <QueryBoundary error={error} isError={isError} isLoading={isLoading} label="skill sources">
          {!sources?.length ? (
            <EmptyState title="No external sources yet. Add one with the button above." />
          ) : (
            <Table>
              <THead>
                <Th variant="compact">Source</Th>
                <Th variant="compact">Pinned / latest</Th>
                <Th variant="compact">Status</Th>
                <Th variant="compact">Scripts</Th>
                <Th variant="compact" />
              </THead>
              <tbody>
                {sources.map((s) => (
                  <TRow key={s.id}>
                    <Td className="py-2 pr-4">
                      <div className="font-medium text-paper-100">{sourceLabel(s)}</div>
                      <div className="text-xs text-paper-500">
                        ref {visibleText(s.ref)} · {s.skillCount} skill
                        {s.skillCount === 1 ? '' : 's'}
                      </div>
                    </Td>
                    <Td className="py-2 pr-4 font-mono text-xs text-paper-400">
                      <span title={s.pinnedSha}>{shortSha(s.pinnedSha)}</span>
                      {' / '}
                      <span title={s.latestSha ?? undefined}>{shortSha(s.latestSha)}</span>
                    </Td>
                    <Td className="py-2 pr-4">
                      <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
                      <div className="mt-0.5 text-xs text-paper-500">
                        {s.lastCheckedAt
                          ? `checked ${formatDate(s.lastCheckedAt)}`
                          : 'never checked'}
                      </div>
                      {s.lastError && (
                        <div className="mt-0.5 text-xs text-brick-400">
                          {visibleText(s.lastError)}
                        </div>
                      )}
                    </Td>
                    <Td className="py-2 pr-4 text-xs text-paper-400">
                      {SCRIPT_MODE_LABEL[s.scriptMode]}
                    </Td>
                    <Td className="py-2 text-right">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        <Button
                          disabled={busyId === s.id || s.status === 'DISABLED'}
                          onClick={() => checkNow(s)}
                          size="sm"
                          variant="ghost"
                        >
                          Check now
                        </Button>
                        {s.status === 'UPDATE_AVAILABLE' && (
                          <Button onClick={() => setReviewId(s.id)} size="sm" variant="primary">
                            Review update
                          </Button>
                        )}
                        {(s.status === 'OK' || s.status === 'UPDATE_AVAILABLE') && (
                          <Button onClick={() => setInstallFor(s)} size="sm" variant="ghost">
                            Install more skills
                          </Button>
                        )}
                        <Button
                          disabled={busyId === s.id}
                          onClick={() =>
                            run(
                              s.id,
                              () =>
                                patch
                                  .mutateAsync({
                                    id: s.id,
                                    status: s.status === 'DISABLED' ? 'OK' : 'DISABLED',
                                  })
                                  .then(() => undefined),
                              'Failed to update the source'
                            )
                          }
                          size="sm"
                          variant="ghost"
                        >
                          {s.status === 'DISABLED' ? 'Enable' : 'Disable'}
                        </Button>
                        <Button
                          disabled={busyId === s.id}
                          onClick={() =>
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
                            )
                          }
                          size="sm"
                          variant="ghost"
                        >
                          {s.scriptMode === 'REJECT' ? 'Allow text files' : 'Reject scripts'}
                        </Button>
                        <Button onClick={() => setDeleteTarget(s)} size="sm" variant="danger">
                          Delete
                        </Button>
                      </div>
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          )}
        </QueryBoundary>
      </Card>

      <AddSourceModal onClose={() => setAddOpen(false)} open={addOpen} />
      <ReviewUpdateModal onClose={() => setReviewId(null)} sourceId={reviewId} />
      <InstallSkillsModal onClose={() => setInstallFor(null)} source={installFor} />
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
