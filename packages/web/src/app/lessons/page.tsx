'use client';

import { useMemo } from 'react';
import { LessonsByTypeChart } from '@/components/charts/LessonsByTypeChart';
import { LessonsOverTimeChart } from '@/components/charts/LessonsOverTimeChart';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { useLessons } from '@/hooks/useWorkflows';
import { groupLessonsByDate, groupLessonsByType } from '@/lib/chartUtils';
import { formatDate } from '@/lib/utils';

export default function LessonsPage() {
  const { data: lessons, isLoading } = useLessons();

  const all = lessons ?? [];
  const typeData = useMemo(() => groupLessonsByType(all), [all]);
  const timeData = useMemo(() => groupLessonsByDate(all), [all]);

  if (isLoading)
    return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading...</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Agent Lessons</h2>

      {/* Charts Section */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Lessons by Failure Type</CardTitle>
          </CardHeader>
          <LessonsByTypeChart data={typeData} />
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Lessons Over Time</CardTitle>
          </CardHeader>
          <LessonsOverTimeChart data={timeData} />
        </Card>
      </div>

      <div className="space-y-4">
        {all.map((l) => (
          <Card key={l.id}>
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <p className="font-medium text-sm">{l.lessonSummary}</p>
                <p className="text-xs text-[var(--muted-foreground)] mt-1">{l.rationale}</p>
              </div>
              {l.failureType && (
                <span className="text-xs bg-red-100 text-red-800 px-2 py-0.5 rounded-full ml-4">
                  {l.failureType.replace(/_/g, ' ')}
                </span>
              )}
            </div>
            <div className="flex gap-4 mt-3 text-xs text-[var(--muted-foreground)]">
              <span>
                {l.repository?.organizationName}/{l.repository?.repoName}
              </span>
              <span>{formatDate(l.createdAt)}</span>
            </div>
          </Card>
        ))}
        {all.length === 0 && (
          <p className="text-center text-[var(--muted-foreground)] py-12">
            No lessons recorded yet
          </p>
        )}
      </div>
    </div>
  );
}
