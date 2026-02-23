'use client';

import { useLessons } from '@/hooks/useWorkflows';
import { Card } from '@/components/ui/Card';
import { formatDate } from '@/lib/utils';

export default function LessonsPage() {
  const { data: lessons, isLoading } = useLessons();

  if (isLoading) return <div className="text-center py-12 text-[var(--muted-foreground)]">Loading...</div>;

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold">Agent Lessons</h2>
      <div className="space-y-4">
        {(lessons ?? []).map((l: any) => (
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
              <span>{l.repository?.organizationName}/{l.repository?.repoName}</span>
              <span>{formatDate(l.createdAt)}</span>
            </div>
          </Card>
        ))}
        {(lessons ?? []).length === 0 && (
          <p className="text-center text-[var(--muted-foreground)] py-12">No lessons recorded yet</p>
        )}
      </div>
    </div>
  );
}
