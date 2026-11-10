import { afterAll, describe, expect, it } from 'vitest';
import { liveEnv, liveGate, liveTitle } from './liveGate.js';

/**
 * The offline eval harness (docs/evals.md §3) against a real stack: a one-case dataset on the
 * fixture repository is flake-screened by the screen workflow, then an eval run scores the seeded
 * `implementer` against itself with a real model in a real Docker workspace.
 *
 * What this establishes is that the machinery turns end to end — the screen records the case as
 * screened, the run leaves RUNNING with a verdict other than INCONCLUSIVE, and its summary exists.
 * It says nothing about the quality of the model's work: the case's golden test
 * (`test/ok.test.js`) passes at the pinned commit by construction, because a reference that fails
 * is a case the harness refuses to score.
 *
 * The eval workspace clones `LIVE_EVALS_REPO_URL` as given, with no platform credential, so the
 * fixture must be a repository the clone can read without one (a public fixture, or a URL that
 * carries its own read credential). Opt in with `LIVE_EVALS=1` on a provisioned stack.
 */
const REQUIRED = [
  'LIVE_E2E_API_URL',
  'LIVE_E2E_TOKEN',
  'LIVE_EVALS_REPO_URL',
  'LIVE_EVALS_BASELINE_SHA',
] as const;
const gate = liveGate('evals', 'LIVE_EVALS', process.env.LIVE_EVALS === '1', REQUIRED);

const SCREEN_TIMEOUT_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 40 * 60_000;
const POLL_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${liveEnv('LIVE_E2E_API_URL')}/api/v1/platform${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      authorization: `Bearer ${liveEnv('LIVE_E2E_TOKEN')}`,
      'content-type': 'application/json',
    },
    method,
    redirect: 'error',
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

interface Dataset {
  data: { cases: Array<{ flakeRuns?: number; flakeScreened?: boolean }>; id: string };
}
interface Run {
  data: { status: string; summary: unknown };
}

describe.skipIf(!gate.enabled)(liveTitle('live eval harness', gate), () => {
  const slug = `live-${Date.now().toString(36)}`;
  let datasetId: string | undefined;

  afterAll(async () => {
    // A dataset has no delete route; the stack it lives in is torn down after the job.
    datasetId = undefined;
  });

  it(
    'screens a case and scores a run to a verdict',
    async () => {
      const created = await api<{ data: { id: string } }>('POST', '/evals', {
        cases: [
          {
            baselineSha: liveEnv('LIVE_EVALS_BASELINE_SHA'),
            goldenTest: 'node --test test/ok.test.js',
            input: 'Read src/sum.js and fix sum() so that it adds its two arguments.',
            repoUrl: liveEnv('LIVE_EVALS_REPO_URL'),
            stack: 'node',
            tags: ['live'],
          },
        ],
        name: `Live eval ${slug}`,
        scope: 'GLOBAL',
        slug,
      });
      datasetId = created.data.id;

      // Creating a dataset with cases starts its flake screen; wait for the case to be screened.
      const screenDeadline = Date.now() + SCREEN_TIMEOUT_MS;
      for (;;) {
        const detail = await api<Dataset>('GET', `/evals/${datasetId}`);
        const only = detail.data.cases[0];
        if (only?.flakeScreened) {
          break;
        }
        if ((only?.flakeRuns ?? 0) > 0) {
          throw new Error('the reference failed its flake screen, so the case cannot be scored');
        }
        if (Date.now() > screenDeadline) {
          throw new Error('timed out waiting for the flake screen');
        }
        await sleep(POLL_MS);
      }

      const started = await api<{ data: { id: string } }>('POST', '/evals/runs', {
        baselineRef: 'implementer',
        candidateRef: 'implementer',
        datasetId,
      });
      const runDeadline = Date.now() + RUN_TIMEOUT_MS;
      let run: Run | undefined;
      for (;;) {
        run = await api<Run>('GET', `/evals/runs/${started.data.id}`);
        if (run.data.status !== 'RUNNING') {
          break;
        }
        if (Date.now() > runDeadline) {
          throw new Error('timed out waiting for the eval run to finish');
        }
        await sleep(POLL_MS);
      }

      // A verdict, not a pass: SUCCESS and FAILED both mean the harness scored the case.
      expect(['SUCCESS', 'FAILED']).toContain(run.data.status);
      expect(run.data.summary).not.toBeNull();
    },
    SCREEN_TIMEOUT_MS + RUN_TIMEOUT_MS + 60_000
  );
});
