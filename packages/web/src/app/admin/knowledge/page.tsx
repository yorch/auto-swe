'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { SkeletonDetail } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import {
  useKnowledge,
  useKnowledgeAction,
  useKnowledgeCreate,
  useKnowledgeDetail,
  useKnowledgePermissions,
} from '@/hooks/useKnowledge';
import { useTeams } from '@/hooks/useTeams';
import { ApiError, api } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { useAuthStore } from '@/stores/authStore';

export default function GovernKnowledgePage() {
  const user = useAuthStore((s) => s.user);
  const teamsQuery = useTeams();
  const teams = teamsQuery.data ?? [];
  const [teamId, setTeamId] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<'read' | 'review'>('read');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [createType, setCreateType] = useState<'REFERENCE' | 'DECISION' | 'POLICY'>('REFERENCE');
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [draftConflict, setDraftConflict] = useState(false);
  const [visibility, setVisibility] = useState<'TEAM' | 'SELECTED_TEAMS' | 'ORGANIZATION'>('TEAM');
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  const teamScope = useQuery({
    enabled: !!teamId,
    queryFn: () =>
      api.get<{ data: { orgId: string } }>(`/api/v1/teams/${teamId}`).then((result) => result.data),
    queryKey: ['knowledge-team-scope', teamId],
  });
  const items = useKnowledge({
    offset,
    q: query.trim() || undefined,
    status: status || undefined,
    type: type || undefined,
    view,
  });
  const perms = useKnowledgePermissions(teamId || undefined, teamScope.data?.orgId);
  const detail = useKnowledgeDetail(selected);
  const create = useKnowledgeCreate();
  const approve = useKnowledgeAction('approve');
  const publish = useKnowledgeAction('publish');
  const reject = useKnowledgeAction('reject');
  const revise = useKnowledgeAction('revise');
  const supersede = useKnowledgeAction('supersede');
  const canManage = !!perms.data?.canManageTeam;
  const selectedItem = detail.data;
  const teamName = useMemo(
    () => teams.find((team) => team.id === teamId)?.name ?? '',
    [teams, teamId]
  );

  async function run(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setDraftConflict(true);
        setError(
          'This item changed. Your draft is preserved; reload the latest version before editing further.'
        );
      } else if (e instanceof ApiError && e.status === 403) {
        setError('You are not authorized for this action. Permissions are enforced by the server.');
        await perms.refetch();
      } else {
        setError(errMsg(e, 'Knowledge action failed'));
      }
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        help={<p>Published summaries do not expose private source evidence.</p>}
        subtitle="Review and manage governed knowledge."
        title="Knowledge"
      />
      <Card>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-sm">
            Team
            <select
              className="mt-1 w-full"
              onChange={(e) => setTeamId(e.target.value)}
              value={teamId}
            >
              <option value="">Choose a team</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Search
            <input
              className="mt-1 w-full"
              maxLength={160}
              onChange={(e) => {
                setOffset(0);
                setQuery(e.target.value);
              }}
              placeholder="Search knowledge"
              value={query}
            />
          </label>
          <label className="text-sm">
            View
            <select
              className="mt-1 w-full"
              onChange={(e) => setView(e.target.value as typeof view)}
              value={view}
            >
              <option value="read">Read: all authorized summaries</option>
              <option value="review">Review: items I can manage</option>
            </select>
          </label>
          <label className="text-sm">
            Status
            <select
              className="mt-1 w-full"
              onChange={(e) => setStatus(e.target.value)}
              value={status}
            >
              <option value="">All readable</option>
              {['UNREVIEWED', 'APPROVED', 'REJECTED', 'SUPERSEDED'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Type
            <select className="mt-1 w-full" onChange={(e) => setType(e.target.value)} value={type}>
              <option value="">All types</option>
              {['LEARNING', 'REFERENCE', 'DECISION', 'POLICY'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        {teamsQuery.isError && (
          <Alert className="mt-3">Unable to load teams. Team management is unavailable.</Alert>
        )}
        {perms.isError && teamId && (
          <Alert className="mt-3">Unable to load permissions. Management actions are hidden.</Alert>
        )}
        {teamScope.isError && teamId && (
          <Alert className="mt-3">
            Unable to load team organization scope. Organization publication is unavailable.
          </Alert>
        )}
        {error && <Alert className="mt-3">{error}</Alert>}
        {canManage && (
          <form
            className="mt-5 grid gap-3 border-t border-ink-400 pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!teamId) {
                return;
              }
              void run(async () => {
                await create.mutateAsync({ content, teamId, title, type: createType });
                setTitle('');
                setContent('');
              });
            }}
          >
            <strong>Create curated reference for {teamName || 'selected team'}</strong>
            <select
              aria-label="Knowledge type"
              onChange={(event) => setCreateType(event.target.value as typeof createType)}
              value={createType}
            >
              <option value="REFERENCE">Reference</option>
              <option value="DECISION">Decision</option>
              <option value="POLICY">Policy</option>
            </select>
            <input
              aria-label="Knowledge title"
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title"
              required
              value={title}
            />
            <textarea
              aria-label="Knowledge content"
              maxLength={12000}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Reviewed source content"
              required
              value={content}
            />
            <Button disabled={!teamId || create.isPending} type="submit">
              Create unreviewed reference
            </Button>
          </form>
        )}
      </Card>
      <QueryBoundary
        error={items.error}
        isError={items.isError}
        isLoading={items.isLoading}
        label="knowledge"
      >
        {!items.data?.data.length ? (
          <EmptyState title="No knowledge matches these filters." />
        ) : (
          <div className="grid gap-3">
            {items.data.data.map((item) => (
              <button
                className="rounded-lg border border-ink-400 p-4 text-left hover:border-paper-600"
                key={item.id}
                onClick={() => {
                  setSelected(item.id);
                  setEditTitle(item.title);
                  setEditContent(item.content);
                  setDraftVersion(item.version);
                  setDraftConflict(false);
                }}
                type="button"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{item.title}</strong>
                  <Badge
                    tone={
                      item.status === 'APPROVED'
                        ? 'moss'
                        : item.status === 'UNREVIEWED'
                          ? 'amber'
                          : 'muted'
                    }
                  >
                    {item.status}
                  </Badge>
                  <Badge tone="violet">{item.trustLabel}</Badge>
                  <Badge tone="neutral">{item.type}</Badge>
                  <Badge tone="dust">{item.visibility}</Badge>
                </div>
                <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-paper-300">
                  {item.content}
                </p>
                <p className="mt-2 text-xs text-paper-500">
                  Version {item.version} · {new Date(item.createdAt).toLocaleString()}
                </p>
              </button>
            ))}
          </div>
        )}
      </QueryBoundary>
      {items.data && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-paper-500">
            Showing {items.data.data.length} items from offset {offset}
          </span>
          <div className="flex gap-2">
            <Button
              disabled={offset === 0 || items.isFetching}
              onClick={() => setOffset(Math.max(0, offset - 25))}
              variant="secondary"
            >
              Previous
            </Button>
            <Button
              disabled={items.data.data.length < 25 || offset >= 100 || items.isFetching}
              onClick={() => setOffset(Math.min(100, offset + 25))}
              variant="secondary"
            >
              Next
            </Button>
          </div>
        </div>
      )}
      {selected && (
        <Card>
          <div className="flex items-start justify-between">
            <h2 className="text-lg font-semibold">Knowledge detail</h2>
            <Button onClick={() => setSelected(null)} variant="secondary">
              Close
            </Button>
          </div>
          {detail.isLoading ? (
            <SkeletonDetail label="knowledge detail" />
          ) : detail.isError ? (
            <Alert>Unable to load detail. It may no longer be available.</Alert>
          ) : (
            selectedItem && (
              <div className="mt-3 space-y-3">
                <p className="text-xs text-paper-500">
                  {selectedItem.type} · {selectedItem.status} · {selectedItem.visibility} · version{' '}
                  {selectedItem.version} · {selectedItem.trustLabel}
                </p>
                {selectedItem.provenance && (
                  <p className="text-xs text-paper-400">
                    Source evidence is visible only where repository access permits. Producer:{' '}
                    {selectedItem.provenance.producerAgentKey ?? 'not recorded'}
                    {selectedItem.provenance.producerNodeId
                      ? ` · node ${selectedItem.provenance.producerNodeId}`
                      : ''}
                  </p>
                )}
                <p className="whitespace-pre-wrap">{selectedItem.content}</p>
                {draftConflict && (
                  <Alert>
                    Your revision draft is unchanged. Reload the latest detail explicitly to begin a
                    new draft.
                    <Button
                      onClick={() => {
                        setEditTitle(selectedItem.title);
                        setEditContent(selectedItem.content);
                        setDraftVersion(selectedItem.version);
                        setDraftConflict(false);
                        setError('');
                      }}
                      variant="secondary"
                    >
                      Reload latest version
                    </Button>
                  </Alert>
                )}
                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    {selectedItem.status === 'UNREVIEWED' && (
                      <>
                        <Button
                          disabled={approve.isPending}
                          onClick={() =>
                            void run(() =>
                              approve.mutateAsync({
                                expectedVersion: selectedItem.version,
                                id: selectedItem.id,
                                visibility: 'TEAM',
                              })
                            )
                          }
                        >
                          Approve team version
                        </Button>
                        <Button
                          onClick={() =>
                            void run(() =>
                              reject.mutateAsync({
                                expectedVersion: selectedItem.version,
                                id: selectedItem.id,
                              })
                            )
                          }
                          variant="secondary"
                        >
                          Reject
                        </Button>
                      </>
                    )}
                    {selectedItem.status === 'APPROVED' && (
                      <>
                        <select
                          aria-label="Publication scope"
                          onChange={(e) =>
                            setVisibility(
                              e.target.value as 'TEAM' | 'SELECTED_TEAMS' | 'ORGANIZATION'
                            )
                          }
                          value={visibility}
                        >
                          <option value="TEAM">Team</option>
                          <option value="SELECTED_TEAMS">Selected teams</option>
                          {perms.data?.canPublishOrganization && (
                            <option value="ORGANIZATION">Organization</option>
                          )}
                        </select>
                        {visibility === 'SELECTED_TEAMS' && (
                          <fieldset className="basis-full">
                            <legend>
                              Recipient teams (organization membership is validated by the server)
                            </legend>
                            {teams
                              .filter((team) => team.id !== teamId)
                              .map((team) => (
                                <label className="mr-3 inline-flex gap-1" key={team.id}>
                                  <input
                                    checked={selectedTeamIds.includes(team.id)}
                                    onChange={(event) =>
                                      setSelectedTeamIds((ids) =>
                                        event.target.checked
                                          ? [...ids, team.id]
                                          : ids.filter((id) => id !== team.id)
                                      )
                                    }
                                    type="checkbox"
                                  />
                                  {team.name}
                                </label>
                              ))}
                          </fieldset>
                        )}
                        <Button
                          disabled={visibility === 'SELECTED_TEAMS' && selectedTeamIds.length === 0}
                          onClick={() =>
                            void run(() =>
                              publish.mutateAsync({
                                expectedVersion: selectedItem.version,
                                id: selectedItem.id,
                                visibility,
                                ...(visibility === 'SELECTED_TEAMS' ? { selectedTeamIds } : {}),
                              })
                            )
                          }
                        >
                          Publish approved version
                        </Button>
                        <Button
                          onClick={() =>
                            void run(() =>
                              supersede.mutateAsync({
                                expectedVersion: selectedItem.version,
                                id: selectedItem.id,
                              })
                            )
                          }
                          variant="secondary"
                        >
                          Supersede
                        </Button>
                      </>
                    )}
                    {(selectedItem.status === 'APPROVED' ||
                      selectedItem.status === 'UNREVIEWED') && (
                      <form
                        className="flex flex-wrap gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run(() =>
                            revise.mutateAsync({
                              content: editContent,
                              expectedVersion: draftVersion ?? selectedItem.version,
                              id: selectedItem.id,
                              title: editTitle,
                            })
                          );
                        }}
                      >
                        <input
                          aria-label="Revised title"
                          onChange={(e) => setEditTitle(e.target.value)}
                          value={editTitle}
                        />
                        <textarea
                          aria-label="Revised content"
                          onChange={(e) => setEditContent(e.target.value)}
                          value={editContent}
                        />
                        <Button
                          disabled={revise.isPending || draftConflict}
                          type="submit"
                          variant="secondary"
                        >
                          Save revision (unreviewed)
                        </Button>
                      </form>
                    )}
                  </div>
                )}
              </div>
            )
          )}
          {user?.role === 'ADMIN' && (
            <p className="mt-2 text-xs text-paper-500">
              Platform administrator actions remain subject to source-access gates on
              repository-origin items.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
