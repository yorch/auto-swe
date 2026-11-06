'use client';

import type { RepositorySummary } from '@auto-swe/shared/types/api';
import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import {
  type KnowledgeBase,
  type KnowledgeBaseFields,
  useKnowledgeBase,
  useKnowledgeBaseAction,
  useSaveKnowledgeBase,
} from '@/hooks/useKnowledgeBases';
import { useShareCandidates } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';
import { isRecord } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';

export function KnowledgeBaseForm({
  kb,
  repositories,
  onClose,
  onSaved,
}: {
  kb?: KnowledgeBase;
  repositories: RepositorySummary[];
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const save = useSaveKnowledgeBase();
  const [connectionId, setConnectionId] = useState(kb?.connectionId ?? '');
  const [fields, setFields] = useState<KnowledgeBaseFields>(() =>
    kb
      ? {
          defaultRef: kb.defaultRef,
          description: kb.description,
          mountName: kb.mountName,
          name: kb.name,
          path: kb.path,
          status: kb.status,
          visibility: kb.visibility,
        }
      : {
          defaultRef: null,
          description: '',
          mountName: '',
          name: '',
          path: '',
          status: 'OK',
          visibility: 'TEAM',
        }
  );
  function set<K extends keyof KnowledgeBaseFields>(key: K, value: KnowledgeBaseFields[K]) {
    setFields((current) => ({ ...current, [key]: value }));
  }
  return (
    <Modal
      onClose={onClose}
      open
      subtitle="Reference material from an onboarded Git repository. Never treated as instructions."
      title={kb ? 'Edit knowledge base' : 'Create knowledge base'}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!save.isPending) {
            save.mutate(
              {
                body: {
                  ...fields,
                  defaultRef: fields.defaultRef?.trim() || null,
                  mountName: fields.mountName.trim(),
                  name: fields.name.trim(),
                  ...(!kb ? { connectionId } : {}),
                },
                id: kb?.id,
              },
              { onSuccess: (row) => onSaved(row.id) }
            );
          }
        }}
      >
        {!kb && (
          <Select
            label="Repository connection"
            onChange={setConnectionId}
            options={repositories.map((repo) => ({
              label: `${repo.organizationName}/${repo.repoName} · ${repo.team.name}`,
              value: repo.id,
            }))}
            required
            value={connectionId}
          />
        )}
        <Input
          label="Name"
          maxLength={200}
          onChange={(e) => set('name', e.target.value)}
          required
          value={fields.name}
        />
        <Input
          hint="Letters, numbers, underscores and hyphens; starts with a letter or number."
          label="Mount name"
          maxLength={80}
          onChange={(e) => set('mountName', e.target.value)}
          pattern={'[a-zA-Z0-9][a-zA-Z0-9_\\-]*'}
          required
          value={fields.mountName}
        />
        <Textarea
          label="Description"
          maxLength={4000}
          onChange={(e) => set('description', e.target.value)}
          value={fields.description}
        />
        <Input
          hint="Relative subdirectory; blank uses the repository root."
          label="Repository path"
          maxLength={1000}
          onChange={(e) => set('path', e.target.value)}
          value={fields.path}
        />
        <Input
          hint="Branch, tag or commit SHA; blank follows the default branch HEAD."
          label="Default ref"
          maxLength={200}
          onChange={(e) => set('defaultRef', e.target.value || null)}
          value={fields.defaultRef ?? ''}
        />
        <Select
          label="Visibility"
          onChange={(value) => set('visibility', value as KnowledgeBaseFields['visibility'])}
          options={[
            { label: 'Owning team only', value: 'TEAM' },
            { label: 'Selected teams in this organization', value: 'SHARED' },
            { label: 'Entire organization', value: 'ORG' },
          ]}
          value={fields.visibility}
        />
        {fields.visibility === 'SHARED' && (
          <p className="text-sm text-paper-400">
            Use Manage shares after saving to select teams. The owning team always retains access.
          </p>
        )}
        {kb && (
          <Select
            label="Status"
            onChange={(value) => set('status', value as KnowledgeBaseFields['status'])}
            options={[
              { label: 'Enabled', value: 'OK' },
              { label: 'Disabled', value: 'DISABLED' },
            ]}
            value={fields.status}
          />
        )}
        {save.isError && <Alert>{errMsg(save.error, 'Could not save the knowledge base.')}</Alert>}
        <ModalFooter
          disabled={!fields.name.trim() || !fields.mountName.trim() || (!kb && !connectionId)}
          isPending={save.isPending}
          onCancel={onClose}
          submitLabel="Save knowledge base"
        />
      </form>
    </Modal>
  );
}

export function KnowledgeBaseShares({ kb, onClose }: { kb: KnowledgeBase; onClose: () => void }) {
  const query = useKnowledgeBase(kb.id);
  const candidates = useShareCandidates(kb.connectionId, true);
  return (
    <Modal
      onClose={onClose}
      open
      subtitle="Only teams in the owning organization can be selected. This does not share the source repository connection."
      title={`Share ${visibleText(kb.name)}`}
    >
      <QueryBoundary {...query} label="current shares" onRetry={() => void query.refetch()}>
        <QueryBoundary {...candidates} label="teams" onRetry={() => void candidates.refetch()}>
          {query.data && candidates.data && (
            <ShareForm
              kb={query.data}
              key={query.data.shares
                ?.map((row) => row.teamId)
                .sort()
                .join(',')}
              onClose={onClose}
              teams={candidates.data}
            />
          )}
        </QueryBoundary>
      </QueryBoundary>
    </Modal>
  );
}
function ShareForm({
  kb,
  teams,
  onClose,
}: {
  kb: KnowledgeBase;
  teams: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(
    () => kb.shares?.map((row) => row.teamId) ?? []
  );
  const save = useKnowledgeBaseAction();
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ action: 'shares', id: kb.id, teamIds: selected }, { onSuccess: onClose });
      }}
    >
      {teams.length === 0 && (
        <p className="text-sm text-paper-400">No other active teams in this organization.</p>
      )}
      {teams.map((team) => (
        <Checkbox
          checked={selected.includes(team.id)}
          key={team.id}
          label={visibleText(team.name)}
          onChange={(e) =>
            setSelected((current) =>
              e.target.checked ? [...current, team.id] : current.filter((id) => id !== team.id)
            )
          }
        />
      ))}
      {save.isError && <Alert>{errMsg(save.error, 'Could not update shares.')}</Alert>}
      <ModalFooter isPending={save.isPending} onCancel={onClose} submitLabel="Save shares" />
    </form>
  );
}

function Findings({ label, value }: { label: string; value: unknown }) {
  const rows = Array.isArray(value)
    ? value.flatMap((row) =>
        isRecord(row) && typeof row.path === 'string' && typeof row.reason === 'string'
          ? [{ path: row.path, reason: row.reason }]
          : []
      )
    : [];
  return (
    <details>
      <summary className="cursor-pointer text-sm text-paper-300">
        {label} ({rows.length})
      </summary>
      <ul className="mt-2 max-h-60 space-y-1 overflow-y-auto text-xs text-paper-400">
        {rows.map((row) => (
          <li className="break-all" key={`${row.path}:${row.reason}`}>
            <code>{visibleText(row.path)}</code> · {visibleText(row.reason.replaceAll('_', ' '))}
          </li>
        ))}
      </ul>
    </details>
  );
}
export function KnowledgeBaseDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const query = useKnowledgeBase(id, true);
  return (
    <Modal
      onClose={onClose}
      open
      size="lg"
      title={visibleText(query.data?.name ?? 'Knowledge base snapshots')}
    >
      <QueryBoundary {...query} label="knowledge base details" onRetry={() => void query.refetch()}>
        {query.data && (
          <div className="space-y-4">
            <p className="text-sm text-paper-400">
              Owner: {visibleText(query.data.connection?.team.name ?? 'Unknown team')} · Mount:
              /workspace/kb/{visibleText(query.data.mountName)} · Path:{' '}
              {visibleText(query.data.path || '/')}
            </p>
            {query.data.lastError && <Alert>{visibleText(query.data.lastError)}</Alert>}
            <h2 className="text-lg font-semibold text-paper-100">Latest snapshots (up to 10)</h2>
            {!query.data.snapshots?.length && (
              <p className="text-sm text-paper-400">
                No snapshots yet. Request reindexing to build the first snapshot.
              </p>
            )}
            {query.data.snapshots?.map((snapshot) => (
              <section className="space-y-3 rounded-md border border-ink-500 p-4" key={snapshot.id}>
                <h3 className="break-all font-mono text-sm text-paper-200">
                  {snapshot.sha} · {snapshot.status}
                </h3>
                <p className="text-xs text-paper-400">
                  {snapshot.fileCount} files · {snapshot.chunkCount} chunks ·{' '}
                  {snapshot.bytes.toLocaleString()} bytes ·{' '}
                  {snapshot.indexedAt
                    ? new Date(snapshot.indexedAt).toLocaleString()
                    : 'Not indexed yet'}
                </p>
                {snapshot.error && <Alert>{visibleText(snapshot.error)}</Alert>}
                <Findings
                  label="Flagged files — excluded from search and checkout"
                  value={snapshot.flaggedFiles}
                />
                <Findings label="Skipped files" value={snapshot.skippedFiles} />
              </section>
            ))}
          </div>
        )}
      </QueryBoundary>
      <ModalFooter cancelLabel="Close" onCancel={onClose} />
    </Modal>
  );
}
