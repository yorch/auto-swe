import { baseBranchFromPayload, isPlatformWorkBranch } from '@auto-swe/shared/lib/gitRef';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import type { FastifyReply } from 'fastify';
import { sendError } from './httpErrors.js';

/**
 * The base branch a template launch asked for in its payload (`baseBranch`),
 * checked before anything is written: a valid branch name, and not one of the
 * platform's own work branches. Answers `400 INVALID_BASE_BRANCH` and returns
 * `{ ok: false }` otherwise.
 *
 * The worker checks the same again (`resolveRunBaseBranch`) — this is the early,
 * readable error; that is the one every launch path passes through.
 */
export async function launchBaseBranch(
  payload: unknown,
  reply: FastifyReply
): Promise<{ ok: true; baseBranch: string | undefined } | { ok: false }> {
  const parsed = baseBranchFromPayload(payload);
  if (!parsed.ok) {
    sendError(reply, 400, 'INVALID_BASE_BRANCH', parsed.message);
    return { ok: false };
  }
  if (parsed.baseBranch === undefined) {
    return { baseBranch: undefined, ok: true };
  }
  const { branchPrefix } = await resolveWorkflowDefaults();
  if (isPlatformWorkBranch(parsed.baseBranch, branchPrefix)) {
    sendError(
      reply,
      400,
      'INVALID_BASE_BRANCH',
      `baseBranch '${parsed.baseBranch}' is a platform work branch; a run may not be based on one`
    );
    return { ok: false };
  }
  return { baseBranch: parsed.baseBranch, ok: true };
}
