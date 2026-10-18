'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { type RunLesson, useRunLessons } from '@/hooks/useLessons';

/** Below this the lesson writer judged its evidence thin; recall labels it the same way. */
const LOW_CONFIDENCE = 0.5;

/** `TEST_FAILURE` → "Test failure". */
function humanize(value: string): string {
  const text = value.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function LessonLine({ lesson, recalledFor }: { lesson: RunLesson; recalledFor?: string[] }) {
  const retired = lesson.consolidatedAt !== null || lesson.supersededAt !== null;
  return (
    <li className="py-2">
      <p className="text-paper-100">{lesson.lessonSummary}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-paper-500">
        {lesson.failureType && (
          <Badge tone="muted" variant="outline">
            {humanize(lesson.failureType)}
          </Badge>
        )}
        {lesson.confidence !== null && lesson.confidence < LOW_CONFIDENCE && (
          <Badge tone="warning" variant="outline">
            Low confidence
          </Badge>
        )}
        {retired && (
          <span title="Merged into or replaced by a newer lesson">No longer recalled</span>
        )}
        {recalledFor && recalledFor.length > 0 && <span>Recalled by {recalledFor.join(', ')}</span>}
      </div>
    </li>
  );
}

/**
 * The lessons this run's agents were given from earlier runs, and the ones it left for later
 * runs (docs/memory.md). Renders nothing for a run that did neither.
 */
export function RunLessons({ runId, live }: { runId: string; live: boolean }) {
  const { data } = useRunLessons(runId, live);
  if (!data || (data.recalled.length === 0 && data.written.length === 0)) {
    return null;
  }
  const parts = [
    data.recalled.length > 0 && `${data.recalled.length} recalled`,
    data.written.length > 0 && `${data.written.length} written`,
  ].filter(Boolean);
  return (
    <details className="rounded border border-ink-700 px-4 py-3 text-sm">
      <summary className="cursor-pointer text-paper-300">
        Lessons
        <span className="ml-2 text-xs text-paper-500">{parts.join(', ')}</span>
      </summary>
      {data.recalled.length > 0 && (
        <section className="mt-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-paper-500">
            Recalled from earlier runs
          </h3>
          <ul className="divide-y divide-ink-700">
            {data.recalled.map((r) =>
              r.lesson ? (
                <LessonLine key={r.lessonId} lesson={r.lesson} recalledFor={r.recalledFor} />
              ) : (
                <li className="py-2 text-paper-500" key={r.lessonId}>
                  A lesson since deleted
                  {r.recalledFor.length > 0 && ` · recalled by ${r.recalledFor.join(', ')}`}
                </li>
              )
            )}
          </ul>
        </section>
      )}
      {data.written.length > 0 && (
        <section className="mt-3">
          <h3 className="text-xs font-medium uppercase tracking-wide text-paper-500">
            Written by this run
          </h3>
          <ul className="divide-y divide-ink-700">
            {data.written.map((lesson) => (
              <LessonLine key={lesson.id} lesson={lesson} />
            ))}
          </ul>
        </section>
      )}
      <p className="mt-3 text-xs text-paper-500">
        <Link className="underline-offset-2 hover:underline" href="/lessons">
          All lessons
        </Link>
      </p>
    </details>
  );
}
