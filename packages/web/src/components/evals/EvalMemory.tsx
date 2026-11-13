import type { EvalDatasetDetail, EvalRunDto } from '@auto-swe/shared/types/api';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';

export function EvalMemoryPins({
  run,
}: {
  run: Pick<EvalRunDto, 'candidateMemoryMode' | 'baselineMemoryMode' | 'corpusHash'>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Lesson memory</CardTitle>
      </CardHeader>
      <div className="space-y-2 p-4 text-sm">
        <p>Candidate memory: {run.candidateMemoryMode ?? 'OFF'}</p>
        <p>Baseline memory: {run.baselineMemoryMode ?? 'OFF'}</p>
        <p className="break-all">Corpus SHA-256: {run.corpusHash ?? 'Not pinned (legacy run)'}</p>
      </div>
    </Card>
  );
}

export function EvalLessonCorpus({ lessons = [] }: { lessons?: EvalDatasetDetail['lessons'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Lesson corpus ({lessons.length})</CardTitle>
      </CardHeader>
      <div className="space-y-3 p-4">
        {lessons.length ? (
          lessons.map((lesson) => (
            <article className="rounded border border-ink-400 p-3" key={lesson.id}>
              <p className="text-xs text-paper-400">
                {lesson.source} · {lesson.failureType ?? 'GENERAL'}
              </p>
              <p className="whitespace-pre-wrap text-sm">{lesson.content}</p>
            </article>
          ))
        ) : (
          <p className="text-sm text-paper-400">
            No lessons. ON and SHADOW require a nonempty corpus.
          </p>
        )}
      </div>
    </Card>
  );
}
