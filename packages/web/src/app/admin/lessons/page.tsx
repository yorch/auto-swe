'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { triggerConsolidationNow, useConsolidationConfig } from '@/hooks/useAdminConfig';
import {
  type LessonRepoStats,
  triggerRepoConsolidation,
  useAdminLessonStats,
  useDeleteLesson,
  useLessons,
} from '@/hooks/useLessons';

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
    <tr className="border-t border-ink-700">
      <td className="py-3 pr-4 font-mono text-xs text-paper-300">
        {repo.organizationName}/{repo.repoName}
      </td>
      <td className="py-3 pr-4 text-center font-mono text-xs text-paper-200">{repo.activeCount}</td>
      <td className="py-3 pr-4 text-center font-mono text-xs text-paper-500">
        {repo.consolidatedCount}
      </td>
      <td className="py-3 pr-4 font-mono text-xs text-paper-500">
        {repo.lastConsolidatedAt ? (
          new Date(repo.lastConsolidatedAt).toLocaleString()
        ) : (
          <span className="text-paper-700">never</span>
        )}
      </td>
      <td className="py-3 text-right">
        <Button
          disabled={triggering || repo.activeCount === 0}
          onClick={handleTrigger}
          size="sm"
          variant="secondary"
        >
          {triggering ? 'Triggering…' : 'Run now'}
        </Button>
      </td>
    </tr>
  );
}

export default function AdminLessonsPage() {
  const { data: stats, isLoading: statsLoading, refetch: refetchStats } = useAdminLessonStats();
  const { data: lessons, isLoading: lessonsLoading } = useLessons(false);
  const { data: consolidation } = useConsolidationConfig();
  const deleteLesson = useDeleteLesson();

  const [triggeringAll, setTriggeringAll] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const handleTriggerAll = async () => {
    setTriggeringAll(true);
    setTriggerError(null);
    try {
      await triggerConsolidationNow();
      void refetchStats();
    } catch (err) {
      setTriggerError(err instanceof Error ? err.message : 'Failed to trigger');
    } finally {
      setTriggeringAll(false);
    }
  };

  const handleTriggerRepo = async (repoId: string) => {
    await triggerRepoConsolidation(repoId);
    void refetchStats();
  };

  const handleDelete = async (id: string) => {
    await deleteLesson.mutateAsync(id);
  };

  const totalActive = stats?.reduce((sum, r) => sum + r.activeCount, 0) ?? 0;
  const totalConsolidated = stats?.reduce((sum, r) => sum + r.consolidatedCount, 0) ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        subtitle="Agent lessons captured from completed workflows. Consolidation merges semantically similar lessons to reduce redundancy."
        title="Admin — Lessons"
      />

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card>
          <div className="py-1">
            <div className="font-mono text-[10px] uppercase tracking-widest text-paper-500">
              Active
            </div>
            <div className="mt-1 font-mono text-3xl font-medium text-paper-100">{totalActive}</div>
          </div>
        </Card>
        <Card>
          <div className="py-1">
            <div className="font-mono text-[10px] uppercase tracking-widest text-paper-500">
              Consolidated
            </div>
            <div className="mt-1 font-mono text-3xl font-medium text-paper-500">
              {totalConsolidated}
            </div>
          </div>
        </Card>
        <Card>
          <div className="py-1">
            <div className="font-mono text-[10px] uppercase tracking-widest text-paper-500">
              Schedule
            </div>
            <div className="mt-1 font-mono text-sm text-paper-200">
              {consolidation?.schedule.exists ? (
                consolidation.schedule.paused ? (
                  <span className="text-paper-500">Paused</span>
                ) : (
                  <span className="text-emerald-400">Active</span>
                )
              ) : (
                <span className="text-paper-700">Not set</span>
              )}
            </div>
            {consolidation?.schedule.nextRunAt && (
              <div className="mt-0.5 font-mono text-[10px] text-paper-600">
                Next: {new Date(consolidation.schedule.nextRunAt).toLocaleString()}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Per-repo breakdown */}
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Repositories">Lesson breakdown by repository</CardTitle>
          <div className="flex items-center gap-3">
            {triggerError && <p className="text-xs text-brick-400">{triggerError}</p>}
            <Button
              disabled={triggeringAll || !consolidation?.schedule.exists}
              onClick={handleTriggerAll}
              size="sm"
              variant="secondary"
            >
              {triggeringAll ? 'Triggering…' : 'Run all now'}
            </Button>
          </div>
        </CardHeader>

        {statsLoading ? (
          <p className="text-sm text-paper-400">Loading…</p>
        ) : !stats || stats.length === 0 ? (
          <p className="text-sm text-paper-600">No repositories found.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr>
                <th className="pb-2 text-left font-mono text-[10px] uppercase tracking-wider text-paper-500">
                  Repository
                </th>
                <th className="pb-2 text-center font-mono text-[10px] uppercase tracking-wider text-paper-500">
                  Active
                </th>
                <th className="pb-2 text-center font-mono text-[10px] uppercase tracking-wider text-paper-500">
                  Consolidated
                </th>
                <th className="pb-2 text-left font-mono text-[10px] uppercase tracking-wider text-paper-500">
                  Last run
                </th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {stats.map((repo) => (
                <RepoStatsRow key={repo.id} onTrigger={handleTriggerRepo} repo={repo} />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Recent active lessons */}
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Recent">Active lessons</CardTitle>
        </CardHeader>

        {lessonsLoading ? (
          <p className="text-sm text-paper-400">Loading…</p>
        ) : !lessons || lessons.length === 0 ? (
          <p className="text-sm text-paper-600">No active lessons.</p>
        ) : (
          <div className="divide-y divide-ink-700">
            {lessons.slice(0, 20).map((lesson) => (
              <div className="flex items-start gap-4 py-3" key={lesson.id}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[10px] text-paper-600">
                      {lesson.repository.organizationName}/{lesson.repository.repoName}
                    </span>
                    {lesson.failureType && (
                      <span className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-paper-500">
                        {lesson.failureType}
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[10px] text-paper-700">
                      {new Date(lesson.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-paper-200">{lesson.lessonSummary}</p>
                  {lesson.rationale && (
                    <p className="mt-0.5 text-xs text-paper-500">{lesson.rationale}</p>
                  )}
                </div>
                <button
                  className="shrink-0 font-mono text-[10px] text-paper-700 hover:text-brick-400"
                  onClick={() => handleDelete(lesson.id)}
                  type="button"
                >
                  delete
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
