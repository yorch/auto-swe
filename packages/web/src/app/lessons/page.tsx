'use client';

import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Stat } from '@/components/ui/Stat';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import { triggerConsolidationNow, useConsolidationConfig } from '@/hooks/useAdminConfig';
import { useDataTableSort } from '@/hooks/useDataTableSort';
import { useHasRole } from '@/hooks/useHasRole';
import {
  type Lesson,
  type LessonRepoStats,
  triggerRepoConsolidation,
  useAdminLessonStats,
  useDeleteLesson,
  useLessons,
} from '@/hooks/useLessons';
import { useRepositories } from '@/hooks/useRepositories';
import { HELP_LINKS } from '@/lib/helpLinks';
import { formatDate, formatRelativeTime } from '@/lib/utils';

const PAGE_SIZE = 20;

/** A timestamp shown relative ("3d ago") with the exact time on hover. */
function Ago({ iso }: { iso: string }) {
  return (
    <time className="whitespace-nowrap" dateTime={iso} title={formatDate(iso)}>
      {formatRelativeTime(iso)}
    </time>
  );
}

/** `TEST_FAILURE` → "Test failure". */
function humanizeEnum(value: string): string {
  const text = value.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Below this the lesson writer judged its evidence thin; recall labels it the same way. */
const LOW_CONFIDENCE = 0.5;

/** The run outcome code recorded on the lesson, when it is one. */
function lessonOutcome(lesson: Lesson): string | null {
  const outcome = lesson.metadata?.outcome;
  return typeof outcome === 'string' && outcome.length > 0 ? outcome : null;
}

const repoName = (r: LessonRepoStats) => `${r.organizationName}/${r.repoName}`;

const REPO_SORT_KEYS = {
  active: (r: LessonRepoStats) => r.activeCount,
  consolidated: (r: LessonRepoStats) => r.consolidatedCount,
  // A repository that was never consolidated sorts last.
  lastConsolidated: (r: LessonRepoStats) =>
    r.lastConsolidatedAt ? new Date(r.lastConsolidatedAt).getTime() : null,
  repository: (r: LessonRepoStats) => repoName(r).toLowerCase(),
};

/**
 * Lessons for every signed-in role. Engineers read the lessons of the repositories they
 * can reach — the gateway scopes the list — because those lessons steer their runs. A lead
 * of a repository's owning team deletes its lessons and consolidates it; the cross-team
 * stats and consolidating everything at once stay with platform ADMINs.
 */
export default function LessonsPage() {
  const isAdmin = useHasRole('ADMIN');
  const queryClient = useQueryClient();
  // The filter's choices: the caller's own repositories, which is every one for an admin.
  const { data: repositories } = useRepositories({ limit: 100 });
  const repoOptions = (repositories ?? []).filter(
    (r) => r.type === 'git_repo' && r.organizationName && r.repoName
  );
  const [repoFilter, setRepoFilter] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  // The search box filters the server's list, so wait for a pause in typing.
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim());
      setOffset(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const {
    data: lessons,
    meta: lessonsMeta,
    isLoading: lessonsLoading,
    isError: lessonsIsError,
    isFetching: lessonsIsFetching,
    error: lessonsError,
    refetch: refetchLessons,
  } = useLessons(false, {
    limit: PAGE_SIZE,
    offset,
    q: query || undefined,
    repoId: repoFilter || undefined,
  });
  const deleteLesson = useDeleteLesson();
  const managed = new Set(lessonsMeta?.managedRepoIds ?? []);
  const canManage = (repoId: string | undefined) => isAdmin || (!!repoId && managed.has(repoId));
  // A lead consolidates the repository they filtered to; an admin has the per-repository table.
  const filteredRepo = repoOptions.find((r) => r.id === repoFilter);

  const [deleting, setDeleting] = useState<{ id: string; summary: string } | null>(null);
  // `null` = nothing asked; `'all'` = every repository; otherwise one repository.
  const [consolidating, setConsolidating] = useState<
    'all' | Pick<LessonRepoStats, 'id' | 'organizationName' | 'repoName'> | null
  >(null);
  const [triggerNotice, setTriggerNotice] = useState<string | null>(null);

  const runConsolidation = async () => {
    const target = consolidating;
    if (!target) {
      return;
    }
    setTriggerNotice(null);
    if (target === 'all') {
      await triggerConsolidationNow();
      setTriggerNotice('Consolidation started for every repository. Counts update as it finishes.');
    } else {
      await triggerRepoConsolidation(target.id);
      setTriggerNotice(
        `Consolidation started for ${target.organizationName}/${target.repoName}. Counts update as it finishes.`
      );
    }
    void queryClient.invalidateQueries({ queryKey: ['admin-lesson-stats'] });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          isAdmin ? <ConsolidateAllButton onAsk={() => setConsolidating('all')} /> : undefined
        }
        help={
          isAdmin ? (
            <p>Consolidation merges semantically similar lessons to reduce redundancy.</p>
          ) : (
            <p>
              These are the lessons of the repositories you can reach. Later runs on a repository
              recall its lessons as context. A lead of a repository's team can delete its lessons
              and merge similar ones; filter to the repository to consolidate it.
            </p>
          )
        }
        learnMore={{ ...HELP_LINKS.conceptsLessons, label: 'What is a lesson?' }}
        subtitle="Agent lessons captured from completed workflows."
        title="Lessons"
      />

      {triggerNotice && <Alert variant="success">{triggerNotice}</Alert>}

      {isAdmin && <LessonAdministration onAsk={setConsolidating} />}

      {/* Recent active lessons */}
      <Card>
        <CardHeader>
          <CardTitle>Active lessons</CardTitle>
        </CardHeader>
        <Toolbar
          end={
            <>
              {!isAdmin && filteredRepo && canManage(filteredRepo.id) && (
                <Button
                  onClick={() =>
                    setConsolidating({
                      id: filteredRepo.id,
                      organizationName: filteredRepo.organizationName ?? '',
                      repoName: filteredRepo.repoName ?? '',
                    })
                  }
                  size="sm"
                >
                  <Icon name="refresh" size={14} />
                  Consolidate this repository
                </Button>
              )}
              {lessonsMeta && (
                <span className="text-xs text-paper-500 tabular-nums">
                  {lessonsMeta.total} lesson{lessonsMeta.total === 1 ? '' : 's'}
                </span>
              )}
            </>
          }
        >
          <SearchInput
            className="sm:w-72"
            label="Search lessons"
            onChange={setSearch}
            placeholder="Words in a lesson or its rationale"
            value={search}
          />
          <Select
            appearance="pill"
            aria-label="Repository"
            onChange={(v) => {
              setRepoFilter(v);
              setOffset(0);
            }}
            options={[
              { label: 'All repositories', value: '' },
              ...repoOptions.map((r) => ({
                label: `${r.organizationName}/${r.repoName}`,
                value: r.id,
              })),
            ]}
            value={repoFilter}
          />
        </Toolbar>

        <QueryBoundary
          error={lessonsError}
          isError={lessonsIsError}
          isFetching={lessonsIsFetching}
          isLoading={lessonsLoading}
          label="lessons"
          onRetry={() => void refetchLessons()}
        >
          {!lessons || lessons.length === 0 ? (
            query || repoFilter ? (
              <EmptyState
                action={
                  <Button
                    onClick={() => {
                      setSearch('');
                      setQuery('');
                      setRepoFilter('');
                      setOffset(0);
                    }}
                    size="sm"
                  >
                    Clear filters
                  </Button>
                }
                icon="search"
                title="No lessons match those filters"
              />
            ) : (
              <EmptyState
                hint={
                  isAdmin
                    ? 'Agents record a lesson when a workflow completes after a failure or a review round. They are reused as context on later runs.'
                    : 'Agents record a lesson when a workflow on one of your repositories completes after a failure or a review round. They are reused as context on later runs.'
                }
                icon="memory"
                title="No active lessons yet"
              />
            )
          ) : (
            <ul className="divide-y divide-ink-600">
              {lessons.map((lesson) => (
                <li className="group flex items-start gap-4 py-4" key={lesson.id}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-relaxed text-paper-100">{lesson.lessonSummary}</p>
                    {lesson.rationale && (
                      <p className="mt-1 text-sm leading-relaxed text-paper-400">
                        {lesson.rationale}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-paper-500">
                      <span className="font-mono">
                        {lesson.repository
                          ? `${lesson.repository.organizationName}/${lesson.repository.repoName}`
                          : 'Deleted repository'}
                      </span>
                      {lesson.failureType && (
                        <Badge tone="muted" variant="outline">
                          {humanizeEnum(lesson.failureType)}
                        </Badge>
                      )}
                      {lessonOutcome(lesson) && (
                        <Badge tone="muted" variant="outline">
                          {humanizeEnum(lessonOutcome(lesson) as string)}
                        </Badge>
                      )}
                      {lesson.confidence !== null && lesson.confidence < LOW_CONFIDENCE && (
                        <Badge
                          title="The agent that wrote this lesson judged its evidence thin"
                          tone="warning"
                          variant="outline"
                        >
                          Low confidence
                        </Badge>
                      )}
                      <span aria-hidden>·</span>
                      <Ago iso={lesson.createdAt} />
                      {lesson.workflowRunId && (
                        <>
                          <span aria-hidden>·</span>
                          <Link
                            className="text-paper-300 underline-offset-2 hover:underline focus-visible:underline"
                            href={`/runs/${lesson.workflowRunId}`}
                          >
                            Source run
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                  {canManage(lesson.repository?.id) && (
                    <Button
                      aria-label="Delete lesson"
                      className="shrink-0 px-2 text-paper-500 hover:text-danger-400"
                      onClick={() => setDeleting({ id: lesson.id, summary: lesson.lessonSummary })}
                      size="sm"
                      title="Delete lesson"
                      variant="ghost"
                    >
                      <Icon name="trash" size={14} />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {lessonsMeta && lessonsMeta.total > PAGE_SIZE && (
            <div className="mt-4">
              <Pagination
                hasNext={offset + PAGE_SIZE < lessonsMeta.total}
                hasPrev={offset > 0}
                onNext={() => setOffset(offset + PAGE_SIZE)}
                onPrev={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                rangeEnd={Math.min(offset + PAGE_SIZE, lessonsMeta.total)}
                rangeStart={offset + 1}
                total={lessonsMeta.total}
              />
            </div>
          )}
        </QueryBoundary>
      </Card>

      <ConfirmModal
        confirmLabel="Run consolidation"
        message={
          consolidating === 'all'
            ? 'Merge semantically similar lessons across every repository now? Merged lessons are marked consolidated and stop appearing in the active list. This can take a few minutes.'
            : `Merge semantically similar lessons for ${consolidating?.organizationName}/${consolidating?.repoName} now? Merged lessons are marked consolidated and stop appearing in the active list.`
        }
        onClose={() => setConsolidating(null)}
        onConfirm={runConsolidation}
        open={consolidating !== null}
        title="Run consolidation"
      />

      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message={`Delete "${deleting?.summary}"? This cannot be undone.`}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) {
            await deleteLesson.mutateAsync(deleting.id);
          }
        }}
        open={deleting !== null}
        title="Delete lesson"
      />
    </div>
  );
}

/** Starts consolidation for every repository; needs the schedule that defines its settings. */
function ConsolidateAllButton({ onAsk }: { onAsk: () => void }) {
  const { data: consolidation } = useConsolidationConfig();
  return (
    <Button
      disabled={!consolidation?.schedule.exists}
      onClick={onAsk}
      title={
        consolidation?.schedule.exists
          ? undefined
          : 'Set a consolidation schedule in Workflow defaults first'
      }
    >
      <Icon name="refresh" size={14} />
      Consolidate all now
    </Button>
  );
}

/** The platform-wide memory health view: totals, the schedule, and per-repository counts. */
function LessonAdministration({ onAsk }: { onAsk: (repo: LessonRepoStats) => void }) {
  const {
    data: stats,
    isLoading: statsLoading,
    isError: statsIsError,
    isFetching: statsIsFetching,
    error: statsError,
    refetch: refetchStats,
  } = useAdminLessonStats();
  const {
    onSortChange: onRepoSortChange,
    sort: repoSort,
    sortRows: sortRepos,
  } = useDataTableSort<LessonRepoStats>(REPO_SORT_KEYS);
  const { data: consolidation } = useConsolidationConfig();
  const totalActive = stats?.reduce((sum, r) => sum + r.activeCount, 0) ?? 0;
  const totalConsolidated = stats?.reduce((sum, r) => sum + r.consolidatedCount, 0) ?? 0;

  return (
    <>
      {/* Summary stats */}
      <Card className="p-5 sm:p-6">
        <h2 className="sr-only">Summary</h2>
        <div className="grid grid-cols-1 gap-x-4 gap-y-8 sm:grid-cols-3">
          <Stat label="Active" value={totalActive} />
          <Stat label="Consolidated" tone="muted" value={totalConsolidated} />
          <Stat
            hint={
              <>
                {consolidation?.schedule.nextRunAt && (
                  <>Next run {formatDate(consolidation.schedule.nextRunAt)} · </>
                )}
                <Link
                  className="text-paper-100 underline-offset-2 hover:underline focus-visible:underline"
                  href="/admin/workflow-defaults#consolidation"
                >
                  Configure
                </Link>
              </>
            }
            label="Schedule"
            tone={
              consolidation?.schedule.exists && !consolidation.schedule.paused
                ? 'success'
                : 'default'
            }
            value={
              consolidation?.schedule.exists
                ? consolidation.schedule.paused
                  ? 'Paused'
                  : 'Active'
                : 'Not set'
            }
          />
        </div>
      </Card>

      {/* Per-repo breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Lessons by repository</CardTitle>
        </CardHeader>

        <QueryBoundary
          error={statsError}
          isError={statsIsError}
          isFetching={statsIsFetching}
          isLoading={statsLoading}
          label="lesson stats"
          onRetry={() => void refetchStats()}
        >
          {!stats || stats.length === 0 ? (
            <EmptyState
              action={
                <ButtonLink href="/connections" size="sm">
                  View connections
                </ButtonLink>
              }
              hint="Lessons are captured per repository once workflows complete against it."
              icon="repositories"
              title="No repositories yet"
            />
          ) : (
            <div className="-mx-4">
              <DataTable
                actions={(repo) => (
                  <Button
                    disabled={repo.activeCount === 0}
                    onClick={() => onAsk(repo)}
                    size="sm"
                    title={repo.activeCount === 0 ? 'No active lessons to consolidate' : undefined}
                  >
                    Run now
                  </Button>
                )}
                actionsLabel="Actions"
                className="max-sm:px-4"
                columns={[
                  {
                    cell: (repo) => <span className="font-mono text-sm">{repoName(repo)}</span>,
                    header: 'Repository',
                    id: 'repository',
                    primary: true,
                    sortable: true,
                  },
                  {
                    align: 'right',
                    cell: (repo) => (
                      <span className="text-paper-200 tabular-nums">{repo.activeCount}</span>
                    ),
                    header: 'Active',
                    id: 'active',
                    sortable: true,
                  },
                  {
                    align: 'right',
                    cell: (repo) => (
                      <span className="text-paper-400 tabular-nums">{repo.consolidatedCount}</span>
                    ),
                    header: 'Consolidated',
                    id: 'consolidated',
                    sortable: true,
                  },
                  {
                    cell: (repo) =>
                      repo.lastConsolidatedAt ? (
                        <span className="text-paper-400">
                          <Ago iso={repo.lastConsolidatedAt} />
                        </span>
                      ) : (
                        <span className="text-paper-500">Never</span>
                      ),
                    header: 'Last consolidated',
                    id: 'lastConsolidated',
                    sortable: true,
                  },
                ]}
                getRowId={(repo) => repo.id}
                onSortChange={onRepoSortChange}
                revealActions={false}
                rows={sortRepos(stats)}
                sort={repoSort}
              />
            </div>
          )}
        </QueryBoundary>
      </Card>
    </>
  );
}
