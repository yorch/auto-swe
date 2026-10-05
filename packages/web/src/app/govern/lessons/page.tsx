'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
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
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';

function RepoStatsRow({
  repo,
  onTrigger,
}: {
  repo: LessonRepoStats;
  onTrigger: (repoId: string) => Promise<void>;
}) {
  const [triggering, setTriggering] = useState(false);

  const handleTrigger = async () => {
    setTriggering(true);
    try {
      await onTrigger(repo.id);
    } finally {
      setTriggering(false);
    }
  };

  return (
    <TRow>
      <Td className="py-3 pr-4 font-mono text-xs text-paper-300">
        {repo.organizationName}/{repo.repoName}
      </Td>
      <Td className="py-3 pr-4 text-center font-mono text-xs text-paper-200">{repo.activeCount}</Td>
      <Td className="py-3 pr-4 text-center font-mono text-xs text-paper-500">
        {repo.consolidatedCount}
      </Td>
      <Td className="py-3 pr-4 font-mono text-xs text-paper-500">
        {repo.lastConsolidatedAt ? (
          formatDate(repo.lastConsolidatedAt)
        ) : (
          <span className="text-paper-600">never</span>
        )}
      </Td>
      <Td className="py-3 text-right">
        <Button
          disabled={triggering || repo.activeCount === 0}
          onClick={handleTrigger}
          size="sm"
          variant="secondary"
        >
          {triggering ? 'Triggering…' : 'Run now'}
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
  const {
    data: lessons,
    isLoading: lessonsLoading,
    isError: lessonsIsError,
    isFetching: lessonsIsFetching,
    error: lessonsError,
    refetch: refetchLessons,
  } = useLessons(false, { limit: 20 });
  const { data: consolidation } = useConsolidationConfig();
  const deleteLesson = useDeleteLesson();

  const [triggeringAll, setTriggeringAll] = useState(false);
  const [deleting, setDeleting] = useState<{ id: string; summary: string } | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const handleTriggerAll = async () => {
    setTriggeringAll(true);
    setTriggerError(null);
    try {
      await triggerConsolidationNow();
      void refetchStats();
    } catch (err) {
      setTriggerError(errMsg(err, 'Failed to trigger'));
    } finally {
      setTriggeringAll(false);
    }
  };

  const handleTriggerRepo = async (repoId: string) => {
    setTriggerError(null);
    try {
      await triggerRepoConsolidation(repoId);
      void refetchStats();
    } catch (err) {
      setTriggerError(errMsg(err, 'Failed to trigger'));
    }
  };

  const totalActive = stats?.reduce((sum, r) => sum + r.activeCount, 0) ?? 0;
  const totalConsolidated = stats?.reduce((sum, r) => sum + r.consolidatedCount, 0) ?? 0;

  return (
    <div className="space-y-8">
      <PageHeader
        chapter="§ Govern"
        subtitle="Agent lessons captured from completed workflows. Consolidation merges semantically similar lessons to reduce redundancy."
        title="Lessons"
      />

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-6">
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
            disabled={triggeringAll || !consolidation?.schedule.exists}
            onClick={handleTriggerAll}
            size="sm"
            variant="secondary"
          >
            {triggeringAll ? 'Triggering…' : 'Run all now'}
          </Button>
        </CardHeader>
        {triggerError && <Alert className="mb-4">{triggerError}</Alert>}

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
            <Table>
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
                  <RepoStatsRow key={repo.id} onTrigger={handleTriggerRepo} repo={repo} />
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

        <QueryBoundary
          error={lessonsError}
          isError={lessonsIsError}
          isFetching={lessonsIsFetching}
          isLoading={lessonsLoading}
          label="lessons"
          onRetry={() => void refetchLessons()}
        >
          {!lessons || lessons.length === 0 ? (
            <EmptyState title="No active lessons." />
          ) : (
            <div className="divide-y divide-ink-600">
              {lessons.slice(0, 20).map((lesson) => (
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
        </QueryBoundary>
      </Card>

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
