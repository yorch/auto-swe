'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { useHasRole } from '@/hooks/useHasRole';
import {
  downloadTranscript,
  useRunTranscripts,
  useTranscriptLegalHold,
} from '@/hooks/useTranscripts';
import { errMsg } from '@/lib/errors';

function sizeLabel(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * A run's agent transcripts (docs/transcripts.md): one row per activity
 * attempt with raw/normalized downloads, and — for admins — a legal-hold
 * toggle that asks for a reason.
 */
export function RunTranscripts({ runId }: { runId: string }) {
  const { data, error, isError, isFetching, isLoading, refetch } = useRunTranscripts(runId);
  const isAdmin = useHasRole('ADMIN');
  const hold = useTranscriptLegalHold(runId);
  const [dialog, setDialog] = useState<'hold' | 'release' | null>(null);
  const [reason, setReason] = useState('');
  const [error_, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const held = data?.some((t) => t.legalHold) ?? false;

  const submit = async () => {
    try {
      await hold.mutateAsync({ held: dialog === 'hold', reason: reason || undefined });
      setDialog(null);
      setReason('');
      setNotice(dialog === 'hold' ? 'Legal hold set' : 'Legal hold released');
    } catch (err) {
      setError(errMsg(err, 'Could not change the legal hold'));
      throw err;
    }
  };

  return (
    <details className="rounded border border-ink-700 px-4 py-3 text-sm">
      <summary className="cursor-pointer text-paper-300">
        Transcripts
        {data && data.length > 0 && (
          <span className="ml-2 text-xs text-paper-500">
            {data.length} {data.length === 1 ? 'attempt' : 'attempts'}
            {held && ' · legal hold'}
          </span>
        )}
      </summary>
      <QueryBoundary
        error={error}
        isError={isError}
        isFetching={isFetching}
        isLoading={isLoading}
        label="transcripts"
        onRetry={() => void refetch()}
        rows={2}
      >
        {data && data.length > 0 ? (
          <div className="mt-3 space-y-2">
            {notice && (
              <Alert announce title="Done" variant="success">
                {notice}
              </Alert>
            )}
            {isAdmin && (
              <div>
                <Button
                  onClick={() => {
                    setReason('');
                    setError(null);
                    setDialog(held ? 'release' : 'hold');
                  }}
                  size="sm"
                  variant="secondary"
                >
                  {held ? 'Release legal hold' : 'Set legal hold'}
                </Button>
              </div>
            )}
            <Table>
              <THead>
                <Th>Activity</Th>
                <Th>Status</Th>
                <Th>Calls</Th>
                <Th>Size</Th>
                <Th>Agents</Th>
                <Th>Download</Th>
              </THead>
              <tbody>
                {data.map((t) => (
                  <TRow key={t.id}>
                    <Td>
                      {t.activityType}
                      <span className="text-paper-500"> · attempt {t.attempt}</span>
                    </Td>
                    <Td>
                      {t.status}
                      {t.legalHold && (
                        <>
                          <span aria-hidden className="ml-1 text-warning-400">
                            ●
                          </span>
                          <span className="sr-only">on legal hold</span>
                        </>
                      )}
                    </Td>
                    <Td>{t.modelCallCount}</Td>
                    <Td>{sizeLabel(t.sizeBytes)}</Td>
                    <Td>{t.agentKeys.join(', ')}</Td>
                    <Td>
                      <button
                        aria-label={`Download raw transcript for ${t.activityType} attempt ${t.attempt}`}
                        className="text-accent-400 hover:underline"
                        onClick={() =>
                          void downloadTranscript(t.id, 'raw').catch((err) =>
                            setError(errMsg(err, 'Download failed'))
                          )
                        }
                        type="button"
                      >
                        raw
                      </button>
                      <span className="mx-1 text-paper-600">/</span>
                      <button
                        aria-label={`Download normalized transcript for ${t.activityType} attempt ${t.attempt}`}
                        className="text-accent-400 hover:underline"
                        onClick={() =>
                          void downloadTranscript(t.id, 'normalized').catch((err) =>
                            setError(errMsg(err, 'Download failed'))
                          )
                        }
                        type="button"
                      >
                        normalized
                      </button>
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
          </div>
        ) : null}
      </QueryBoundary>
      <Modal onClose={() => setDialog(null)} open={dialog === 'hold'} title="Set legal hold">
        <div className="space-y-3 text-sm text-paper-400">
          <p>
            A legal hold exempts this run's transcripts from retention pruning until it is released.
          </p>
          <Input
            autoComplete="off"
            label="Reason (required)"
            onChange={(e) => setReason(e.target.value)}
            value={reason}
          />
          {error_ && <Alert>{error_}</Alert>}
          <ModalFooter
            disabled={!reason.trim()}
            onCancel={() => setDialog(null)}
            onSubmit={() => void submit()}
            submitLabel="Set hold"
          />
        </div>
      </Modal>
      <Modal onClose={() => setDialog(null)} open={dialog === 'release'} title="Release legal hold">
        <div className="space-y-3 text-sm text-paper-400">
          <p>Retention pruning applies to this run's transcripts again from the next sweep.</p>
          {error_ && <Alert>{error_}</Alert>}
          <ModalFooter
            onCancel={() => setDialog(null)}
            onSubmit={() => void submit()}
            submitLabel="Release"
          />
        </div>
      </Modal>
      {error_ && !dialog && <Alert>{error_}</Alert>}
    </details>
  );
}
