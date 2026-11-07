'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { useLinkRepoEvalDataset, useRepoEvalDatasets } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';

/**
 * The eval datasets the user may link to this repository's setup secrets, and which of them run
 * their cases' workspace setup with them: the team's datasets for a team admin, the
 * organization's for an organization admin. GLOBAL datasets are linked from the platform eval
 * admin page. Hidden when the user may link none.
 */
export function RepoEvalDatasets({ repositoryId }: { repositoryId: string }) {
  const datasets = useRepoEvalDatasets(repositoryId);
  const link = useLinkRepoEvalDataset(repositoryId);
  const [error, setError] = useState<string | null>(null);
  if (datasets.isLoading || (!datasets.isError && !datasets.data?.length)) {
    return null;
  }
  return (
    <div className="space-y-2 rounded-lg border border-ink-600 p-3">
      <h4 className="text-sm text-paper-200">Eval datasets using these secrets</h4>
      <p className="text-xs text-paper-500">
        A linked dataset's cases get these setup secrets in their workspace setup. A dataset reads
        one repository's secrets; linking it here replaces any other.
      </p>
      {datasets.data?.length ? (
        <ul className="space-y-1">
          {datasets.data.map((d) => (
            <li className="flex items-center justify-between gap-2 text-sm" key={d.id}>
              <span className="min-w-0">
                <span className="text-paper-200">{d.name}</span>{' '}
                <span className="font-mono text-xs text-paper-500">{d.slug}</span>
                {d.scope === 'ORGANIZATION' && (
                  <span className="ml-1 text-xs text-paper-500">(organization)</span>
                )}
                {d.usesRepository && (
                  <span className="block text-xs text-paper-500">
                    Uses {d.usesRepository.name}'s secrets
                  </span>
                )}
              </span>
              <Button
                aria-label={`${d.linked ? 'Unlink' : 'Link'} eval dataset ${d.name}`}
                disabled={link.isPending}
                onClick={() => {
                  setError(null);
                  link.mutate(
                    { datasetId: d.id, linked: !d.linked },
                    { onError: (err) => setError(errMsg(err, 'The dataset could not be updated')) }
                  );
                }}
                size="sm"
                variant={d.linked ? 'ghost' : 'secondary'}
              >
                {d.linked ? 'Unlink' : 'Link'}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {datasets.isError && (
        <Alert variant="error">
          {errMsg(datasets.error, 'The eval datasets could not be read')}
        </Alert>
      )}
      {error && <Alert variant="error">{error}</Alert>}
    </div>
  );
}
