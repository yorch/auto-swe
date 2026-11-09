'use client';

import { useQuery } from '@tanstack/react-query';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { SkeletonDetail } from '@/components/ui/LoadingState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { RelativeTime } from '@/components/ui/RelativeTime';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import {
  type KnowledgeItem,
  useKnowledge,
  useKnowledgeAction,
  useKnowledgeCreate,
  useKnowledgeDetail,
  useKnowledgePermissions,
} from '@/hooks/useKnowledge';
import { useTeamParam } from '@/hooks/useTeamParam';
import { useTeams } from '@/hooks/useTeams';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { ApiError, api } from '@/lib/api';
import { errMsg } from '@/lib/errors';
import { HELP_LINKS } from '@/lib/helpLinks';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';

const PAGE_SIZE = 25;
// The gateway refuses an offset above this, so the list stops at MAX_OFFSET + PAGE_SIZE items.
const MAX_OFFSET = 100;
const SEARCH_DEBOUNCE_MS = 300;

type Visibility = 'TEAM' | 'SELECTED_TEAMS' | 'ORGANIZATION';
type Pending =
  | { kind: 'reject'; item: KnowledgeItem }
  | { kind: 'supersede'; item: KnowledgeItem }
  | { kind: 'publish'; item: KnowledgeItem; visibility: Visibility; selectedTeamIds: string[] };

/** `SELECTED_TEAMS` becomes "Selected teams". */
function humanize(value: string): string {
  const text = value.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const STATUS_TONE: Record<string, BadgeTone> = {
  APPROVED: 'success',
  REJECTED: 'danger',
  SUPERSEDED: 'muted',
  UNREVIEWED: 'warning',
};

const STATUS_OPTIONS = [
  { label: 'All statuses', value: '' },
  ...['UNREVIEWED', 'APPROVED', 'REJECTED', 'SUPERSEDED'].map((value) => ({
    label: humanize(value),
    value,
  })),
];
const TYPE_OPTIONS = [
  { label: 'All types', value: '' },
  ...['LEARNING', 'REFERENCE', 'DECISION', 'POLICY'].map((value) => ({
    label: humanize(value),
    value,
  })),
];
const CREATE_TYPE_OPTIONS = [
  { label: 'Reference', value: 'REFERENCE' },
  { label: 'Decision', value: 'DECISION' },
  { label: 'Policy', value: 'POLICY' },
];
const VIEW_OPTIONS = [
  { label: 'Read: all summaries I can see', value: 'read' },
  { label: 'Review: items I can manage', value: 'review' },
];

function Knowledge() {
  const user = useAuthStore((s) => s.user);
  const teamsQuery = useTeams();
  const teams = teamsQuery.data ?? [];
  const teamFromSlug = useTeamParam();
  const [teamId, setTeamId] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<'read' | 'review'>('read');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [createType, setCreateType] = useState<'REFERENCE' | 'DECISION' | 'POLICY'>('REFERENCE');
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  // What the draft was started from; a draft that differs from it is unsaved work.
  const [baseline, setBaseline] = useState<{ title: string; content: string } | null>(null);
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [draftConflict, setDraftConflict] = useState(false);
  const [visibility, setVisibility] = useState<Visibility>('TEAM');
  const [selectedTeamIds, setSelectedTeamIds] = useState<string[]>([]);
  // A pick that would discard the revision draft waits here for confirmation; `'close'` closes.
  const [pendingSwitch, setPendingSwitch] = useState<KnowledgeItem | 'close' | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);

  // `?team=<slug>` (from a team space) preselects the team once its slug has resolved.
  const slugTeamId = teamFromSlug.teamId;
  useEffect(() => {
    if (slugTeamId) {
      setTeamId(slugTeamId);
    }
  }, [slugTeamId]);

  // Typing filters the server's list: wait for a pause.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const teamScope = useQuery({
    enabled: !!teamId,
    queryFn: () =>
      api.get<{ data: { orgId: string } }>(`/api/v1/teams/${teamId}`).then((result) => result.data),
    queryKey: ['knowledge-team-scope', teamId],
  });
  const items = useKnowledge({
    offset,
    q: query || undefined,
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
  const dirty =
    selected !== null &&
    baseline !== null &&
    (editTitle !== baseline.title || editContent !== baseline.content);
  useUnsavedChangesGuard(dirty);
  const filtersActive = !!(query || status || type || view !== 'read');

  function clearFilters() {
    setSearch('');
    setQuery('');
    setStatus('');
    setType('');
    setView('read');
    setOffset(0);
  }

  function openItem(item: KnowledgeItem) {
    setSelected(item.id);
    setEditTitle(item.title);
    setEditContent(item.content);
    setBaseline({ content: item.content, title: item.title });
    setDraftVersion(item.version);
    setDraftConflict(false);
    setError('');
    setNotice('');
    setPendingSwitch(null);
    // The detail can be far from the row: bring it into view and give it focus.
    requestAnimationFrame(() => {
      detailHeading.current?.scrollIntoView?.({ block: 'start' });
      detailHeading.current?.focus();
    });
  }

  function closeDetail() {
    setSelected(null);
    setBaseline(null);
    setPendingSwitch(null);
  }

  function requestOpen(item: KnowledgeItem) {
    if (item.id === selected) {
      detailHeading.current?.focus();
      return;
    }
    if (dirty) {
      setPendingSwitch(item);
    } else {
      openItem(item);
    }
  }

  /** Runs a lifecycle action; reports success as a status message, failure as an alert. */
  async function run(action: () => Promise<unknown>, success?: string, isDraft = false) {
    setError('');
    setNotice('');
    try {
      await action();
      if (success) {
        setNotice(success);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        if (isDraft) {
          // The conflict alert beside the draft carries the explanation.
          setDraftConflict(true);
        } else {
          setError(
            'This item changed while you were looking at it. Reload to see the latest version.'
          );
        }
      } else if (e instanceof ApiError && e.status === 403) {
        setError("You can't do that here. Ask a lead of this team if you need it.");
        await perms.refetch();
      } else {
        setError(errMsg(e, 'Knowledge action failed'));
      }
    }
  }

  function confirmCopy(p: Pending): { title: string; message: string; label: string } {
    if (p.kind === 'reject') {
      return {
        label: 'Reject',
        message: `Reject "${p.item.title}"? It will not be used as approved knowledge. You can still revise it afterwards.`,
        title: 'Reject this item',
      };
    }
    if (p.kind === 'supersede') {
      return {
        label: 'Supersede',
        message: `Mark "${p.item.title}" as superseded? It stops being offered as current knowledge and cannot be approved again.`,
        title: 'Supersede this item',
      };
    }
    const where =
      p.visibility === 'ORGANIZATION'
        ? 'everyone in your organization'
        : `${p.selectedTeamIds.length} selected team${p.selectedTeamIds.length === 1 ? '' : 's'}`;
    return {
      label: 'Publish',
      message: `Publish "${p.item.title}" to ${where}? Published summaries do not show private source evidence, but the content becomes readable by them.`,
      title: 'Publish this item',
    };
  }

  async function performPending(p: Pending) {
    const base = { expectedVersion: p.item.version, id: p.item.id };
    if (p.kind === 'reject') {
      await run(() => reject.mutateAsync(base), 'Item rejected.');
    } else if (p.kind === 'supersede') {
      await run(() => supersede.mutateAsync(base), 'Item superseded.');
    } else {
      await run(
        () =>
          publish.mutateAsync({
            ...base,
            visibility: p.visibility,
            ...(p.visibility === 'SELECTED_TEAMS' ? { selectedTeamIds: p.selectedTeamIds } : {}),
          }),
        p.visibility === 'ORGANIZATION'
          ? 'Published to the organization.'
          : 'Published to the selected teams.'
      );
    }
  }

  const needsRecipients = visibility === 'SELECTED_TEAMS' && selectedTeamIds.length === 0;
  const listed = items.data?.data ?? [];
  const capped = offset >= MAX_OFFSET && listed.length >= PAGE_SIZE;
  const scopeOptions = [
    { label: 'My team', value: 'TEAM' },
    { label: 'Selected teams', value: 'SELECTED_TEAMS' },
    ...(perms.data?.canPublishOrganization
      ? [{ label: 'Whole organization', value: 'ORGANIZATION' }]
      : []),
  ];

  const detailCard = selected && (
    <Card className="lg:sticky lg:top-4 lg:self-start">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold outline-none" ref={detailHeading} tabIndex={-1}>
          {selectedItem?.title ?? 'Knowledge detail'}
        </h2>
        <Button
          onClick={() => (dirty ? setPendingSwitch('close') : closeDetail())}
          size="sm"
          variant="secondary"
        >
          Close
        </Button>
      </div>
      {detail.isLoading ? (
        <SkeletonDetail label="knowledge detail" />
      ) : detail.isError ? (
        <Alert
          action={
            <Button onClick={() => void detail.refetch()} size="sm">
              Retry
            </Button>
          }
        >
          Could not load this item. It may have been removed.
        </Alert>
      ) : (
        selectedItem && (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-paper-500">
              {humanize(selectedItem.type)} · {humanize(selectedItem.status)} ·{' '}
              {humanize(selectedItem.visibility)} · version {selectedItem.version} ·{' '}
              {selectedItem.trustLabel}
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
            <p className="whitespace-pre-wrap text-sm">{selectedItem.content}</p>
            {draftConflict && (
              <Alert
                action={
                  <Button
                    onClick={() => {
                      setEditTitle(selectedItem.title);
                      setEditContent(selectedItem.content);
                      setBaseline({ content: selectedItem.content, title: selectedItem.title });
                      setDraftVersion(selectedItem.version);
                      setDraftConflict(false);
                      setError('');
                    }}
                    size="sm"
                  >
                    Reload latest version
                  </Button>
                }
                variant="warning"
              >
                This item changed since you opened it. Your draft is kept. Reload the latest version
                to start a new draft from it.
              </Alert>
            )}
            {!canManage && (
              <p className="text-xs text-paper-500">
                {teamId
                  ? 'You can read this item. Leads of the team manage it.'
                  : 'Choose a team above to see the actions you have on its items.'}
              </p>
            )}
            {canManage && (
              <div className="space-y-4 border-t border-ink-400 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  {selectedItem.status === 'UNREVIEWED' && (
                    <>
                      <Button
                        disabled={approve.isPending}
                        onClick={() =>
                          void run(
                            () =>
                              approve.mutateAsync({
                                expectedVersion: selectedItem.version,
                                id: selectedItem.id,
                                visibility: 'TEAM',
                              }),
                            'Approved for the team.'
                          )
                        }
                      >
                        Approve team version
                      </Button>
                      <Button
                        onClick={() => setPending({ item: selectedItem, kind: 'reject' })}
                        variant="secondary"
                      >
                        Reject
                      </Button>
                    </>
                  )}
                  {selectedItem.status === 'APPROVED' && (
                    <Button
                      onClick={() => setPending({ item: selectedItem, kind: 'supersede' })}
                      variant="secondary"
                    >
                      Supersede
                    </Button>
                  )}
                </div>
                {selectedItem.status === 'APPROVED' && (
                  <div className="space-y-3">
                    <Select
                      className="max-w-xs"
                      label="Publish to"
                      onChange={(v) => setVisibility(v as Visibility)}
                      options={scopeOptions}
                      value={visibility}
                    />
                    {visibility === 'SELECTED_TEAMS' && (
                      <fieldset className="space-y-2">
                        <legend className="label-mono">Recipient teams</legend>
                        <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-ink-400 p-3">
                          {teams
                            .filter((team) => team.id !== teamId)
                            .map((team) => (
                              <Checkbox
                                checked={selectedTeamIds.includes(team.id)}
                                key={team.id}
                                label={team.name}
                                onChange={(event) =>
                                  setSelectedTeamIds((ids) =>
                                    event.target.checked
                                      ? [...ids, team.id]
                                      : ids.filter((id) => id !== team.id)
                                  )
                                }
                              />
                            ))}
                        </div>
                        <p className="text-xs text-paper-500">
                          {selectedTeamIds.length} selected. Teams must belong to the same
                          organization.
                        </p>
                      </fieldset>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        aria-describedby={needsRecipients ? 'publish-hint' : undefined}
                        disabled={needsRecipients || publish.isPending}
                        onClick={() => {
                          if (visibility === 'TEAM') {
                            void run(
                              () =>
                                publish.mutateAsync({
                                  expectedVersion: selectedItem.version,
                                  id: selectedItem.id,
                                  visibility,
                                }),
                              'Published to the team.'
                            );
                          } else {
                            setPending({
                              item: selectedItem,
                              kind: 'publish',
                              selectedTeamIds,
                              visibility,
                            });
                          }
                        }}
                      >
                        Publish approved version
                      </Button>
                      {needsRecipients && (
                        <span className="text-xs text-paper-500" id="publish-hint">
                          Select at least one recipient team to publish.
                        </span>
                      )}
                    </div>
                  </div>
                )}
                {(selectedItem.status === 'APPROVED' || selectedItem.status === 'UNREVIEWED') && (
                  <form
                    className="space-y-3 border-t border-ink-400 pt-4"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(
                        async () => {
                          await revise.mutateAsync({
                            content: editContent,
                            expectedVersion: draftVersion ?? selectedItem.version,
                            id: selectedItem.id,
                            title: editTitle,
                          });
                          setBaseline({ content: editContent, title: editTitle });
                        },
                        'Revision saved as unreviewed.',
                        true
                      );
                    }}
                  >
                    <h3 className="text-sm font-semibold text-paper-200">Revise</h3>
                    <Input
                      label="Revised title"
                      maxLength={200}
                      onChange={(e) => setEditTitle(e.target.value)}
                      value={editTitle}
                    />
                    <Textarea
                      hint={`${editContent.length}/12000`}
                      label="Revised content"
                      maxLength={12000}
                      mono={false}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={8}
                      value={editContent}
                    />
                    <Button
                      disabled={revise.isPending || draftConflict}
                      type="submit"
                      variant="secondary"
                    >
                      {revise.isPending ? 'Saving…' : 'Save revision (unreviewed)'}
                    </Button>
                  </form>
                )}
              </div>
            )}
          </div>
        )
      )}
      {user?.role === 'ADMIN' && (
        <p className="mt-3 text-xs text-paper-500">
          Administrator actions on items that came from a repository still need access to that
          repository's source.
        </p>
      )}
    </Card>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        help={<p>Published summaries do not expose private source evidence.</p>}
        learnMore={{ ...HELP_LINKS.knowledge, label: 'About knowledge' }}
        subtitle="Curated references, decisions and policies that agents recall. Lessons are captured from runs; knowledge is reviewed by people before it is trusted."
        title="Knowledge"
      />
      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Select
            hint="Pick a team to create or review its items."
            label="Team"
            onChange={setTeamId}
            options={[
              { label: 'Choose a team', value: '' },
              ...teams.map((team) => ({ label: team.name, value: team.id })),
            ]}
            value={teamId}
          />
          <Input
            label="Search"
            maxLength={160}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search knowledge…"
            type="search"
            value={search}
          />
          <Select
            hint={view === 'review' ? 'Only items you can manage.' : undefined}
            label="View"
            onChange={(v) => {
              setView(v as typeof view);
              setOffset(0);
            }}
            options={VIEW_OPTIONS}
            value={view}
          />
          <Select
            label="Status"
            onChange={(v) => {
              setStatus(v);
              setOffset(0);
            }}
            options={STATUS_OPTIONS}
            value={status}
          />
          <Select
            label="Type"
            onChange={(v) => {
              setType(v);
              setOffset(0);
            }}
            options={TYPE_OPTIONS}
            value={type}
          />
        </div>
        {filtersActive && (
          <div className="mt-3">
            <Button onClick={clearFilters} size="sm" variant="ghost">
              Clear filters
            </Button>
          </div>
        )}
        {teamsQuery.isError && (
          <Alert className="mt-3">Could not load your teams. Team actions are unavailable.</Alert>
        )}
        {perms.isError && teamId && (
          <Alert className="mt-3">Could not load your permissions. Actions are hidden.</Alert>
        )}
        {teamScope.isError && teamId && (
          <Alert className="mt-3">
            Could not load this team's organization. Publishing to the organization is unavailable.
          </Alert>
        )}
        {error && <Alert className="mt-3">{error}</Alert>}
        {notice && (
          <Alert className="mt-3" variant="success">
            {notice}
          </Alert>
        )}
        {canManage && (
          <form
            className="mt-5 space-y-3 border-t border-ink-400 pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!teamId) {
                return;
              }
              void run(async () => {
                await create.mutateAsync({ content, teamId, title, type: createType });
                setTitle('');
                setContent('');
              }, 'Reference created. It stays unreviewed until approved.');
            }}
          >
            <h2 className="text-sm font-semibold text-paper-200">
              Create a reference for {teamName || 'the selected team'}
            </h2>
            <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
              <Select
                label="Knowledge type"
                onChange={(v) => setCreateType(v as typeof createType)}
                options={CREATE_TYPE_OPTIONS}
                value={createType}
              />
              <Input
                label="Title"
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                required
                value={title}
              />
            </div>
            <Textarea
              hint={`${content.length}/12000`}
              label="Content"
              maxLength={12000}
              mono={false}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Reviewed source content"
              required
              rows={6}
              value={content}
            />
            <Button disabled={!teamId || create.isPending} type="submit">
              {create.isPending ? 'Creating…' : 'Create unreviewed reference'}
            </Button>
          </form>
        )}
        {!canManage && !teamId && (
          <p className="mt-3 text-xs text-paper-500">
            You can read published knowledge. Leads create and review items for their team: choose a
            team to see what you can do.
          </p>
        )}
      </Card>
      <div className={cn('grid gap-6', selected && 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]')}>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Items</CardTitle>
            </CardHeader>
            <QueryBoundary
              error={items.error}
              isError={items.isError}
              isFetching={items.isFetching}
              isLoading={items.isLoading}
              label="knowledge"
              onRetry={() => void items.refetch()}
            >
              {listed.length === 0 ? (
                filtersActive || offset > 0 ? (
                  <EmptyState
                    action={
                      <Button
                        onClick={() => {
                          clearFilters();
                        }}
                        size="sm"
                      >
                        Clear filters
                      </Button>
                    }
                    icon="search"
                    title="No knowledge matches these filters"
                  />
                ) : (
                  <EmptyState
                    hint="Leads create references, decisions and policies for their team. Agents also propose learnings from runs."
                    icon="memory"
                    title="No knowledge yet"
                  />
                )
              ) : (
                <ul className="grid gap-3">
                  {listed.map((item) => {
                    const isSelected = item.id === selected;
                    return (
                      <li key={item.id}>
                        <button
                          aria-current={isSelected ? 'true' : undefined}
                          className={cn(
                            'w-full rounded-lg border p-4 text-left transition-colors hover:border-paper-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400',
                            isSelected ? 'border-accent-400 bg-ink-700' : 'border-ink-400'
                          )}
                          onClick={() => requestOpen(item)}
                          type="button"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <strong>{item.title}</strong>
                            <Badge tone={STATUS_TONE[item.status] ?? 'muted'}>
                              {humanize(item.status)}
                            </Badge>
                            <Badge tone="neutral">{humanize(item.type)}</Badge>
                          </div>
                          <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm text-paper-300">
                            {item.content}
                          </p>
                          <p className="mt-2 text-xs text-paper-500">
                            {humanize(item.visibility)} · {item.trustLabel} · version {item.version}{' '}
                            · <RelativeTime value={item.createdAt} />
                          </p>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </QueryBoundary>
            {items.data && listed.length > 0 && (
              <nav
                aria-label="Pagination"
                className="mt-4 flex flex-wrap items-center justify-between gap-2"
              >
                <span className="text-sm text-paper-400 tabular-nums">
                  {offset + 1}–{offset + listed.length}
                </span>
                <div className="flex gap-2">
                  <Button
                    disabled={offset === 0 || items.isFetching}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    size="sm"
                  >
                    Previous
                  </Button>
                  <Button
                    disabled={listed.length < PAGE_SIZE || offset >= MAX_OFFSET || items.isFetching}
                    onClick={() => setOffset(Math.min(MAX_OFFSET, offset + PAGE_SIZE))}
                    size="sm"
                  >
                    Next
                  </Button>
                </div>
              </nav>
            )}
            {capped && (
              <p className="mt-2 text-xs text-paper-500">
                Showing the first {MAX_OFFSET + PAGE_SIZE} results. Narrow your search to see
                others.
              </p>
            )}
          </Card>
        </div>
        {detailCard}
      </div>

      <ConfirmModal
        confirmLabel={pending ? confirmCopy(pending).label : 'Confirm'}
        dangerous={pending?.kind !== 'publish'}
        message={pending ? confirmCopy(pending).message : ''}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending) {
            await performPending(pending);
          }
        }}
        open={pending !== null}
        title={pending ? confirmCopy(pending).title : 'Confirm'}
      />
      <ConfirmModal
        confirmLabel="Discard draft"
        dangerous
        message="Your revision draft has not been saved. Continuing discards it."
        onClose={() => setPendingSwitch(null)}
        onConfirm={() => {
          if (pendingSwitch === 'close') {
            closeDetail();
          } else if (pendingSwitch) {
            openItem(pendingSwitch);
          }
        }}
        open={pendingSwitch !== null}
        title="Discard your draft?"
      />
    </div>
  );
}

export default function GovernKnowledgePage() {
  return (
    <Suspense>
      <Knowledge />
    </Suspense>
  );
}
