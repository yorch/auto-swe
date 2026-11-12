'use client';

import { useState } from 'react';
import { PageHelp } from '@/components/help/PageHelp';
import {
  KnowledgeBaseDetail,
  KnowledgeBaseForm,
  KnowledgeBaseShares,
} from '@/components/knowledgeBases/KnowledgeBaseDialogs';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import {
  type KnowledgeBase,
  useKnowledgeBaseAction,
  useKnowledgeBases,
} from '@/hooks/useKnowledgeBases';
import { useRepositories } from '@/hooks/useRepositories';
import { useLedTeamIds } from '@/hooks/useTeams';
import { errMsg } from '@/lib/errors';
import { canWriteTeamResource } from '@/lib/teamPermissions';
import { visibleText } from '@/lib/visibleText';
import { useAuthStore } from '@/stores/authStore';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit' | 'delete' | 'shares'; kb: KnowledgeBase }
  | { kind: 'detail'; id: string };
export default function KnowledgeBasesPage() {
  const bases = useKnowledgeBases();
  const repositories = useRepositories({ limit: 500 });
  const led = useLedTeamIds();
  const role = useAuthStore((state) => state.user?.role);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState('');
  const action = useKnowledgeBaseAction();
  const canManage = (teamId: string | undefined) => canWriteTeamResource(role, teamId, led);
  const eligible = (repositories.data ?? []).filter(
    (repo) =>
      repo.type === 'git_repo' &&
      repo.isActive &&
      canManage(repo.team.id) &&
      !bases.data?.some((kb) => kb.connectionId === repo.id)
  );
  const rows = (bases.data ?? []).filter((kb) =>
    `${kb.name} ${kb.description} ${kb.connection?.team.name ?? ''}`
      .toLowerCase()
      .includes(search.toLowerCase())
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
  return (
    <div className="space-y-6">
      <PageHelp>
        <p>
          Repository-backed reference material. Read-only, pinned for each run and always untrusted.
        </p>
      </PageHelp>
      {notice && <Alert variant="success">{notice}</Alert>}
      {action.isError && (
        <Alert>{errMsg(action.error, 'Could not update the knowledge base.')}</Alert>
      )}
      <Toolbar
        end={
          eligible.length > 0 && (
            <Button onClick={() => setDialog({ kind: 'create' })} variant="primary">
              Create knowledge base
            </Button>
          )
        }
      >
        <SearchInput
          label="Search knowledge bases"
          onChange={(value) => {
            setSearch(value);
            setPage(0);
          }}
          placeholder="Search knowledge bases…"
          value={search}
        />
      </Toolbar>
      <QueryBoundary {...bases} label="knowledge bases" onRetry={() => void bases.refetch()}>
        {!rows.length && (
          <EmptyState
            bordered
            hint={
              search
                ? 'Try another name or team.'
                : 'A team lead can connect an onboarded Git repository. Onboard one in Connections first if needed.'
            }
            icon="layers"
            title={search ? 'No matching knowledge bases' : 'No knowledge bases yet'}
          />
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          {rows.slice(currentPage * 20, (currentPage + 1) * 20).map((kb) => (
            <Card className="space-y-3" key={kb.id}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-paper-100">{visibleText(kb.name)}</h2>
                <Badge tone={kb.status === 'OK' ? 'success' : 'muted'}>{kb.status}</Badge>
              </div>
              <p className="text-sm text-paper-300">{visibleText(kb.description)}</p>
              <p className="text-xs text-paper-400">
                Owner team: {visibleText(kb.connection?.team.name ?? 'Unknown team')} ·{' '}
                {kb.visibility} · /workspace/kb/{visibleText(kb.mountName)}
              </p>
              <p className="text-xs text-paper-400">
                Last indexed:{' '}
                {kb.lastIndexedSha ? (
                  <code title={kb.lastIndexedSha}>{kb.lastIndexedSha.slice(0, 7)}</code>
                ) : (
                  'No snapshot'
                )}
                {kb.lastIndexedAt && (
                  <>
                    {' '}
                    · <RelativeTime value={kb.lastIndexedAt} />
                  </>
                )}
              </p>
              {kb.lastError && <Alert>{visibleText(kb.lastError)}</Alert>}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setDialog({ id: kb.id, kind: 'detail' })}>
                  Details and snapshots
                </Button>
                {canManage(kb.connection?.teamId) && (
                  <>
                    <Button onClick={() => setDialog({ kb, kind: 'edit' })}>Edit</Button>
                    {kb.visibility === 'SHARED' && (
                      <Button onClick={() => setDialog({ kb, kind: 'shares' })}>
                        Manage shares
                      </Button>
                    )}
                    <Button
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate(
                          { action: 'reindex', id: kb.id },
                          {
                            onSuccess: () =>
                              setNotice(
                                'Reindex requested. Open details to follow snapshot status.'
                              ),
                          }
                        )
                      }
                    >
                      Reindex
                    </Button>
                    <Button onClick={() => setDialog({ kb, kind: 'delete' })} variant="danger">
                      Delete
                    </Button>
                  </>
                )}
              </div>
            </Card>
          ))}
        </div>
        {rows.length > 20 && (
          <div className="flex items-center justify-end gap-3 text-sm text-paper-400">
            <Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
              Previous
            </Button>
            <span>Page {currentPage + 1}</span>
            <Button
              disabled={(currentPage + 1) * 20 >= rows.length}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </QueryBoundary>
      {(dialog?.kind === 'create' || dialog?.kind === 'edit') && (
        <KnowledgeBaseForm
          kb={dialog.kind === 'edit' ? dialog.kb : undefined}
          onClose={() => setDialog(null)}
          onSaved={(id) => {
            setNotice('Knowledge base saved.');
            setDialog({ id, kind: 'detail' });
          }}
          repositories={eligible}
        />
      )}
      {dialog?.kind === 'detail' && (
        <KnowledgeBaseDetail id={dialog.id} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'shares' && (
        <KnowledgeBaseShares kb={dialog.kb} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmModal
          confirmLabel="Delete knowledge base"
          dangerous
          message={`Delete ${visibleText(dialog.kb.name)}, its links and indexed snapshots? Future resolutions will no longer include it.`}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            action.mutateAsync({ action: 'delete', id: dialog.kb.id }).then(() => {
              setDialog(null);
              setNotice('Knowledge base deleted.');
            })
          }
          open
          title="Delete knowledge base?"
        />
      )}
    </div>
  );
}
