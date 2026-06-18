import { prisma } from '@auto-swe/shared/db';
import { resolveWorkflowDefaults } from '@auto-swe/shared/lib/systemConfig';
import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { CiPollDeadlineError, runCiPollLoop } from '../lib/scm/ciPollLoop.js';
import { getScmProvider, toRepoRef } from '../lib/scm/index.js';

export interface CiWaitConfig {
  mode: 'signal' | 'poll';
  intervalSec: number;
  graceSec: number;
  deadlineSec: number;
}

/**
 * Resolve the CI-wait strategy + poll tunables from workflow defaults. Called as
 * a step before the CI gate so the spec can route between the signal and poll
 * paths and feed the poller its timings. Re-resolved per run (env/DB-driven).
 */
export async function resolveCiWaitConfig(): Promise<CiWaitConfig> {
  const d = await resolveWorkflowDefaults();
  return {
    deadlineSec: d.ciPollDeadlineSec,
    graceSec: d.ciPollGraceSec,
    intervalSec: d.ciPollIntervalSec,
    mode: d.ciWaitMode,
  };
}

export interface WaitForCiByPollingInput {
  repoId: string;
  /** Branch or SHA to poll CI for (the PR head). */
  ref: string;
  intervalSec: number;
  graceSec: number;
  deadlineSec: number;
}

/**
 * Long-running activity that polls GitHub for CI status until it resolves, the
 * no-checks grace window elapses, or the deadline is exceeded.
 *
 * NB: the result key is `ciPassed`, NOT `passed`. The interpreter treats any
 * step output with a top-level `passed === false` as a failed quality gate and
 * terminates the run — which would bypass the `checkCI` cond and the CI-fix
 * retry loop. By naming it `ciPassed` and letting the following `storePollResult`
 * set node map it into `context.ciResultPayload.passed`, CI failures flow through
 * `checkCI` exactly like the webhook (`ciPipelineSignal`) path.
 */
export async function waitForCiByPolling(
  input: WaitForCiByPollingInput
): Promise<{ ciPassed: boolean; logsUrl?: string }> {
  const repo = await prisma.connection.findUniqueOrThrow({ where: { id: input.repoId } });
  const repoRef = toRepoRef(repo);
  const scm = getScmProvider(repoRef);

  try {
    const result = await runCiPollLoop(
      {
        fetchStatus: () => scm.fetchCiStatus(repoRef, input.ref),
        heartbeat: () => heartbeat(`ci poll: ${input.ref}`),
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      {
        deadlineSec: input.deadlineSec,
        graceSec: input.graceSec,
        intervalSec: input.intervalSec,
      }
    );
    return { ciPassed: result.passed, logsUrl: result.logsUrl };
  } catch (err) {
    if (err instanceof CiPollDeadlineError) {
      // Deadline is terminal, not transient — don't let Temporal retry the poll.
      throw ApplicationFailure.nonRetryable(err.message, 'CI_POLL_DEADLINE');
    }
    throw err;
  }
}
