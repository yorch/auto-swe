'use client';

import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Pagination } from '@/components/ui/Pagination';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Stat } from '@/components/ui/Stat';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { triggerConsolidationNow, useConsolidationConfig } from '@/hooks/useAdminConfig';
import {
  type LessonRepoStats,
  triggerRepoConsolidation,
  useAdminLessonStats,
  useDeleteLesson,
  useLessons,
} from '@/hooks/useLessons';
import { formatDate } from '@/lib/utils';

const PAGE_SIZE = 20;

function RepoStatsRow({
  repo,
  onAsk,
}: {
  repo: LessonRepoStats;
  onAsk: (repo: LessonRepoStats) => void;
}) {
  return (
    <TRow>
      <Td className="py-3 pr-4 font-mono text-xs text-paper-300" primary>
        {repo.organizationName}/{repo.repoName}
      </Td>
      <Td className="py-3 pr-4 text-center font-mono text-xs text-paper-200" label="Active">
        {repo.activeCount}
      </Td>
      <Td className="py-3 pr-4 text-center font-mono text-xs text-paper-500" label="Consolidated">
        {repo.consolidatedCount}
      </Td>
      <Td className="py-3 pr-4 font-mono text-xs text-paper-500" label="Last run">
        {repo.lastConsolidatedAt ? (
          formatDate(repo.lastConsolidatedAt)
        ) : (
          <span className="text-paper-600">never</span>
        )}
      </Td>
      <Td className="py-3 text-right">
        <Button
          disabled={repo.activeCount === 0}
          onClick={() => onAsk(repo)}
          size="sm"
          variant="secondary"
        >
          Run now
        </Button>
      </Td>
    </TRow>
  );
}

export default function GovernLessonsPage() {
  const {
    data: stats,
    isLoading: statsLoading,
    isError: statsIsError,
    isFetching: statsIsFetching,
    error: statsError,
    refetch: refetchStats,
  } = useAdminLessonStats();
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
  const { data: consolidation } = useConsolidationConfig();
  const deleteLesson = useDeleteLesson();

  const [deleting, setDeleting] = useState<{ id: string; summary: string } | null>(null);
  // `null` = nothing asked; `'all'` = every repository; otherwise one repository.
  const [consolidating, setConsolidating] = useState<'all' | LessonRepoStats | null>(null);
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
    void refetchStats();
  };

  const totalActive = stats?.reduce((sum, r) => sum + r.activeCount, 0) ?? 0;
  const totalConsolidated = stats?.reduce((sum, r) => sum + r.consolidatedCount, 0) ?? 0;

  return (
    <div className="space-y-8">
      <PageHeader
        subtitle="Agent lessons captured from completed workflows. Consolidation merges semantically similar lessons to reduce redundancy."
        title="Lessons"
      />

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
        <Stat label="Active" value={totalActive} />
        <Stat label="Consolidated" tone="muted" value={totalConsolidated} />
        <Stat
          hint={
            consolidation?.schedule.nextRunAt && (
              <>Next: {formatDate(consolidation.schedule.nextRunAt)}</>
            )
          }
          label="Schedule"
          tone={
            consolidation?.schedule.exists && !consolidation.schedule.paused ? 'moss' : 'default'
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

      {/* Per-repo breakdown */}
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Repositories">Lesson breakdown by repository</CardTitle>
          <Button
            disabled={!consolidation?.schedule.exists}
            onClick={() => setConsolidating('all')}
            size="sm"
            variant="secondary"
          >
            Run all now
          </Button>
        </CardHeader>
        {triggerNotice && (
          <Alert className="mb-4" variant="success">
            {triggerNotice}
          </Alert>
        )}

        <QueryBoundary
          error={statsError}
          isError={statsIsError}
          isFetching={statsIsFetching}
          isLoading={statsLoading}
          label="lesson stats"
          onRetry={() => void refetchStats()}
        >
          {!stats || stats.length === 0 ? (
            <EmptyState title="No repositories found." />
          ) : (
            <Table stacked>
              <THead>
                <Th className="py-2 pl-0 pr-4">Repository</Th>
                <Th align="center" className="py-2 pl-0 pr-4">
                  Active
                </Th>
                <Th align="center" className="py-2 pl-0 pr-4">
                  Consolidated
                </Th>
                <Th className="py-2 pl-0 pr-4">Last run</Th>
                <Th className="py-2 px-0" />
              </THead>
              <tbody>
                {stats.map((repo) => (
                  <RepoStatsRow key={repo.id} onAsk={setConsolidating} repo={repo} />
                ))}
              </tbody>
            </Table>
          )}
        </QueryBoundary>
      </Card>

      {/* Recent active lessons */}
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Recent">Active lessons</CardTitle>
        </CardHeader>
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <Select
            label="Repository"
            onChange={(v) => {
              setRepoFilter(v);
              setOffset(0);
            }}
            options={[
              { label: 'All repositories', value: '' },
              ...(stats ?? []).map((r) => ({
                label: `${r.organizationName}/${r.repoName}`,
                value: r.id,
              })),
            ]}
            value={repoFilter}
          />
          <Input
            label="Search lessons"
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Words in a lesson or its rationale"
            type="search"
            value={search}
          />
        </div>

        <QueryBoundary
          error={lessonsError}
          isError={lessonsIsError}
          isFetching={lessonsIsFetching}
          isLoading={lessonsLoading}
          label="lessons"
          onRetry={() => void refetchLessons()}
        >
          {!lessons || lessons.length === 0 ? (
            <EmptyState
              title={query || repoFilter ? 'No lessons match those filters.' : 'No active lessons.'}
            />
          ) : (
            <div className="divide-y divide-ink-600">
              {lessons.map((lesson) => (
                <div className="flex items-start gap-4 py-3" key={lesson.id}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[10px] text-paper-600">
                        {lesson.repository.organizationName}/{lesson.repository.repoName}
                      </span>
                      {lesson.failureType && (
                        <Badge className="text-[10px]" tone="muted" uppercase>
                          {lesson.failureType}
                        </Badge>
                      )}
                      <span className="ml-auto font-mono text-[10px] text-paper-600">
                        {formatDate(lesson.createdAt)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-paper-200">{lesson.lessonSummary}</p>
                    {lesson.rationale && (
                      <p className="mt-0.5 text-xs text-paper-500">{lesson.rationale}</p>
                    )}
                  </div>
                  <Button
                    className="shrink-0"
                    onClick={() => setDeleting({ id: lesson.id, summary: lesson.lessonSummary })}
                    size="sm"
                    variant="danger"
                  >
                    Delete
                  </Button>
                </div>
              ))}
            </div>
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
