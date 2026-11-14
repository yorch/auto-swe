'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { useImportEvalLessons } from '@/hooks/useAdmin';
import { useRepositories } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';

const MAX_LESSONS = 50;

/**
 * Fills a dataset's lesson corpus from the lessons a repository's runs have recorded: the newest
 * active ones, at most 50. The import replaces the whole corpus, so a run started afterwards
 * pins a different hash from one started before.
 */
export function EvalLessonImport({
  datasetId,
  lessonCount,
  teamId,
  teamScoped,
}: {
  datasetId: string;
  lessonCount: number;
  /** The owning team of a TEAM dataset, which may import only from its own repositories. */
  teamId: string | null;
  teamScoped: boolean;
}) {
  const repositories = useRepositories({ limit: 500 });
  const importLessons = useImportEvalLessons(datasetId);
  const [repoId, setRepoId] = useState('');
  const [limit, setLimit] = useState(String(MAX_LESSONS));
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const count = Number(limit);
  const limitOk = Number.isInteger(count) && count >= 1 && count <= MAX_LESSONS;
  const options = [
    { label: 'Choose a repository', value: '' },
    ...(repositories.data ?? [])
      .filter((r) => r.type === 'git_repo' && (!teamScoped || r.team?.id === teamId))
      .map((r) => ({ label: `${r.organizationName}/${r.repoName}`, value: r.id })),
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle hint="Replaces the lesson corpus with a repository's recorded lessons">
          Import lessons
        </CardTitle>
      </CardHeader>
      <div className="space-y-3 p-4">
        <p className="text-sm text-paper-400">
          Copies the newest active lessons of one repository into this dataset, up to {MAX_LESSONS}.
          Lessons memory modes ON and SHADOW read this corpus.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-72">
            <Select label="Repository" onChange={setRepoId} options={options} value={repoId} />
          </div>
          <div className="w-28">
            <Input
              error={limitOk ? undefined : `1 to ${MAX_LESSONS}`}
              label="Most lessons"
              max={MAX_LESSONS}
              min={1}
              onChange={(e) => setLimit(e.target.value)}
              type="number"
              value={limit}
            />
          </div>
          <Button disabled={!repoId || !limitOk} onClick={() => setConfirming(true)} size="sm">
            Import lessons
          </Button>
        </div>
        {note && <Alert variant="success">{note}</Alert>}
        {repositories.isError && (
          <Alert variant="error">
            {errMsg(repositories.error, 'Repositories could not be read')}
          </Alert>
        )}
      </div>
      <ConfirmModal
        confirmLabel="Import and replace"
        dangerous={lessonCount > 0}
        message={
          lessonCount > 0
            ? `The ${lessonCount} lesson${lessonCount === 1 ? '' : 's'} in this dataset's corpus are replaced by the newest ${count} from the chosen repository. Runs started afterwards pin the new corpus.`
            : `The newest ${count} lessons of the chosen repository become this dataset's corpus.`
        }
        onClose={() => setConfirming(false)}
        onConfirm={async () => {
          const r = await importLessons.mutateAsync({ limit: count, repoId });
          setNote(
            r.count === 0
              ? 'That repository has no active lessons, so the corpus is now empty.'
              : `Imported ${r.count} lesson${r.count === 1 ? '' : 's'}.`
          );
        }}
        open={confirming}
        pendingLabel="Importing…"
        title="Replace this dataset's lessons?"
      />
    </Card>
  );
}
