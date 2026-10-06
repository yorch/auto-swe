'use client';

import { useMemo, useState } from 'react';
import { VersionDiff } from '@/components/agents/VersionDiff';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Modal } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { type AgentRow, useAgentVersions, useRestoreAgentVersion } from '@/hooks/useAgentLibrary';
import { diffAgentVersions } from '@/lib/agentDiff';
import { modelLabel } from '@/lib/agentDisplay';
import { formatDate } from '@/lib/utils';

/**
 * Every version of one agent: who saved it, what it runs, what changed from the version before,
 * and a way back. Restoring never rewrites history — it saves a new version with the old settings,
 * so runs pinned to any version keep resolving it.
 */
export function AgentHistoryModal({
  agent,
  mcpNames,
  credentialNames,
  onClose,
}: {
  agent: AgentRow;
  mcpNames?: ReadonlyMap<string, string>;
  credentialNames?: ReadonlyMap<string, string>;
  onClose: () => void;
}) {
  const {
    data: versions,
    error,
    isError,
    isFetching,
    isLoading,
    refetch,
  } = useAgentVersions(agent.id);
  const restore = useRestoreAgentVersion();
  const [selected, setSelected] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [restored, setRestored] = useState<number | null>(null);

  const latestVersion = versions?.[0]?.version;
  // Default to the newest change when nothing has been picked yet.
  const selectedId = selected ?? versions?.[0]?.id ?? null;
  const index = versions?.findIndex((v) => v.id === selectedId) ?? -1;
  const current = index >= 0 ? versions?.[index] : undefined;
  const previous = index >= 0 ? versions?.[index + 1] : undefined;
  const changes = useMemo(
    () =>
      current && previous
        ? diffAgentVersions(previous, current, { credentials: credentialNames, mcp: mcpNames })
        : [],
    [current, previous, credentialNames, mcpNames]
  );
  const restoreTarget = versions?.find((v) => v.id === restoring);

  return (
    <>
      <Modal
        onClose={onClose}
        open
        size="lg"
        subtitle="Saving an edit creates a new version. Runs in progress keep the version they started with."
        title={`History of ${agent.name}`}
      >
        <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
          {restored !== null && (
            <Alert variant="success">
              Saved as version {restored}. New runs use it straight away.
            </Alert>
          )}
          {warnings.length > 0 && (
            <Alert variant="warning">Content scan warnings: {warnings.join('; ')}</Alert>
          )}
          <QueryBoundary
            error={error}
            isError={isError}
            isFetching={isFetching}
            isLoading={isLoading}
            label="versions"
            onRetry={() => void refetch()}
          >
            <Table>
              <THead>
                <Th variant="compact">Version</Th>
                <Th variant="compact">Saved</Th>
                <Th variant="compact">Model</Th>
                <Th variant="compact" />
              </THead>
              <tbody>
                {(versions ?? []).map((v) => (
                  <TRow className={v.id === selectedId ? 'bg-ink-800' : undefined} key={v.id}>
                    <Td className="py-2 pr-3">
                      <span className="tabular-nums text-paper-100">v{v.version}</span>
                      {v.version === latestVersion && (
                        <Badge className="ml-2" tone="moss">
                          Current
                        </Badge>
                      )}
                      {v.isVerified && (
                        <Badge className="ml-1" tone="muted" variant="text">
                          Verified
                        </Badge>
                      )}
                    </Td>
                    <Td className="py-2 pr-3 text-xs text-paper-400">
                      {formatDate(v.createdAt)}
                      {v.createdByEmail && <div className="text-paper-500">{v.createdByEmail}</div>}
                    </Td>
                    <Td className="py-2 pr-3 font-mono text-xs text-paper-400">{modelLabel(v)}</Td>
                    <Td className="py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          aria-label={`Show what changed in version ${v.version}`}
                          onClick={() => setSelected(v.id)}
                          size="sm"
                          variant="ghost"
                        >
                          Changes
                        </Button>
                        {v.version !== latestVersion && (
                          <Button
                            aria-label={`Restore version ${v.version} as a new version`}
                            onClick={() => setRestoring(v.id)}
                            size="sm"
                            variant="secondary"
                          >
                            Restore
                          </Button>
                        )}
                      </div>
                    </Td>
                  </TRow>
                ))}
              </tbody>
            </Table>
            {current && (
              <section aria-label="Changes">
                <h3 className="mb-2 text-sm font-medium text-paper-100">
                  {previous
                    ? `What changed from v${previous.version} to v${current.version}`
                    : `v${current.version} is the first version`}
                </h3>
                {previous && <VersionDiff changes={changes} />}
              </section>
            )}
          </QueryBoundary>
        </div>
      </Modal>
      <ConfirmModal
        confirmLabel="Restore as new version"
        message={
          restoreTarget
            ? `This saves a new version v${(latestVersion ?? 0) + 1} with the settings of v${restoreTarget.version}. Nothing is deleted, and runs already in progress keep the version they started with.`
            : ''
        }
        onClose={() => setRestoring(null)}
        onConfirm={async () => {
          if (restoreTarget) {
            const res = await restore.mutateAsync({ id: agent.id, versionId: restoreTarget.id });
            setWarnings([...(res.scanWarnings ?? []), ...(res.skillWarnings ?? [])]);
            setRestored(res.data.version);
            setSelected(null);
            setRestoring(null);
          }
        }}
        open={restoring !== null}
        pendingLabel="Restoring…"
        title={restoreTarget ? `Restore version ${restoreTarget.version}?` : 'Restore version'}
      />
    </>
  );
}
