import type { RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { ApplicationFailure } from '@temporalio/activity';

/**
 * Resolve the run's target `Connection`, or fail with an error that names the
 * step that needed one.
 *
 * `RepoWorkRequest.repoId` is nullable because the generic triggers accept a
 * payload with no `connectionId` — a workflow that only calls `agent` or
 * API nodes has no repository to point at. They used to pass an
 * empty string instead, so a repo-scoped step failed deep inside Prisma with
 * "No Connection found" for an id nobody supplied, giving no hint that the run
 * simply was not connection-scoped.
 *
 * Steps that genuinely need a repository call this and get a message that says
 * which step, and what to do about it. `why` says what the step uses the
 * connection for when that is not an obvious clone, so the message is precise.
 */
export function requireRepoId(
  request: Pick<RepoWorkRequest, 'repoId'>,
  step: string,
  why?: string
): string {
  if (!request.repoId) {
    const reason = why ? ` (${why})` : '';
    throw ApplicationFailure.nonRetryable(
      `Step '${step}' needs a repository${reason}, but this run is not scoped to a connection. ` +
        'Supply `connectionId` in the run payload, or use a template whose steps do not ' +
        'touch a repository.',
      'NO_CONNECTION',
      { step }
    );
  }
  return request.repoId;
}
