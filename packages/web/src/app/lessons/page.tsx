'use client';

import { useMemo, useState } from 'react';
import { LessonsByTypeChart } from '@/components/charts/LessonsByTypeChart';
import { LessonsOverTimeChart } from '@/components/charts/LessonsOverTimeChart';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { useLessonSearch, useLessons } from '@/hooks/useLessons';
import { useRepositories } from '@/hooks/useRepositories';
import { groupLessonsByDate, groupLessonsByType } from '@/lib/chartUtils';
import { formatDate } from '@/lib/utils';

const LESSONS_PAGE_SIZE = 200;

export default function LessonsPage() {
  // The gateway caps this list at 200; the charts and the list below cover
  // the loaded page and the caption says so when more exist.
  const {
    data: lessons,
    meta,
    isLoading,
    isError,
    error: loadError,
  } = useLessons(false, { limit: LESSONS_PAGE_SIZE });
  const { data: repos = [] } = useRepositories();
  const [query, setQuery] = useState('');
  const [repoId, setRepoId] = useState('');
  const searchEnabled = query.trim().length > 0 && !!repoId;
  const { data: searchResults, isFetching: searchLoading } = useLessonSearch(
    searchEnabled ? query.trim() : '',
    searchEnabled ? repoId : null
  );

  const all = lessons ?? [];
  const visible = searchEnabled ? (searchResults ?? []) : all;
  const truncated = meta !== undefined && meta.total > all.length;
  const typeData = useMemo(() => groupLessonsByType(all), [all]);
  const timeData = useMemo(() => groupLessonsByDate(all), [all]);

  if (isLoading || isError) {
    return (
      <QueryBoundary error={loadError} isError={isError} isLoading={isLoading} label="lessons" />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        chapter={`§ Memory · ${meta?.total ?? all.length} total`}
        subtitle={
          truncated
            ? `Showing the first ${all.length} of ${meta.total} lessons — search by repository to find older ones.`
            : undefined
        }
        title="Agent Lessons"
      />

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

      {/* Search bar — text + repo are both required by the API */}
      <Card variant="inset">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_240px]">
          <Input
            label="Search"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. retry, timeout, race condition"
            value={query}
          />
          <Select
            id="lesson-repo"
            label="Repository"
            onChange={(e) => setRepoId(e.target.value)}
            value={repoId}
          >
            <option value="">All repos (no search)</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.organizationName}/{r.repoName}
              </option>
            ))}
          </Select>
        </div>
        {searchEnabled && (
          <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-paper-500">
            {searchLoading
              ? 'Searching…'
              : `${visible.length} match${visible.length === 1 ? '' : 'es'} for "${query.trim()}"`}
          </p>
        )}
      </Card>

      <div className="space-y-4">
        {visible.map((l) => (
          <Card key={l.id}>
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <p className="font-medium text-sm">{l.lessonSummary}</p>
                <p className="text-xs text-paper-400 mt-1">{l.rationale}</p>
              </div>
              {l.failureType && (
                <span className="text-xs bg-brick-400/20 text-brick-400 px-2 py-0.5 rounded font-mono uppercase tracking-wider ml-4">
                  {l.failureType.replace(/_/g, ' ')}
                </span>
              )}
            </div>
            <div className="flex gap-4 mt-3 text-xs text-paper-400">
              <span>
                {l.repository?.organizationName}/{l.repository?.repoName}
              </span>
              <span>{formatDate(l.createdAt)}</span>
            </div>
          </Card>
        ))}
        {visible.length === 0 && (
          <p className="text-center text-paper-400 py-12">
            {searchEnabled ? 'No matches.' : 'No lessons recorded yet'}
          </p>
        )}
      </div>
    </div>
  );
}
