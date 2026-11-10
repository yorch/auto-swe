import { afterAll, describe, expect, it } from 'vitest';
import { liveEnv, liveGate, liveTitle } from './liveGate.js';

/**
 * The flagship path against real infrastructure: a ticket goes in through the gateway, real
 * Temporal runs the workflow, a real Docker workspace and a real model change a fixture
 * repository, and a pull request comes out whose CI is green.
 *
 * The fixture's default branch is red on purpose (`infra/live-e2e/fixture`: `sum` subtracts). The
 * check asserts that
 *   1. a pull request is opened for the ticket's branch, and
 *   2. CI on that pull request heals — its head commit ends with every check run green, whether on
 *      the first push or after the platform's own CI-fix loop pushed a follow-up commit.
 *
 * Opt in with `LIVE_E2E=1` on a stack that `scripts/live-e2e-stack.mjs bootstrap` provisioned.
 * Cost and credentials: docs/live-checks.md.
 */
const REQUIRED = [
  'LIVE_E2E_API_URL',
  'LIVE_E2E_TOKEN',
  'LIVE_E2E_REPO_ID',
  'LIVE_E2E_FIXTURE_REPO',
  'GITHUB_TOKEN',
] as const;
const gate = liveGate('end-to-end', 'LIVE_E2E', process.env.LIVE_E2E === '1', REQUIRED);

const PR_TIMEOUT_MS = 25 * 60_000;
const CI_TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 15_000;

interface GhPull {
  head: { ref: string; sha: string };
  number: number;
  state: string;
}
interface GhCheckRuns {
  check_runs: Array<{ conclusion: string | null; name: string; status: string }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function github<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${liveEnv('GITHUB_TOKEN')}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    method,
    redirect: 'error',
  });
  const text = await res.text();
  if (!res.ok && res.status !== 404 && res.status !== 422) {
    throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : null) as T;
}

/** Poll `probe` until it returns a value or `timeoutMs` passes. */
async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${Math.round(timeoutMs / 60_000)} min waiting for ${what}`);
    }
    await sleep(POLL_MS);
  }
}

describe.skipIf(!gate.enabled)(
  liveTitle('live end-to-end: ticket to green pull request', gate),
  () => {
    const ticket = `LIVE-${Date.now().toString(36)}`;
    let pull: GhPull | undefined;

    afterAll(async () => {
      // Close the pull request and delete its branch so the fixture repository stays tidy. The
      // fixture's default branch is never touched, so the next run starts from the same bug.
      if (!pull) {
        return;
      }
      const repo = liveEnv('LIVE_E2E_FIXTURE_REPO');
      await github('PATCH', `/repos/${repo}/pulls/${pull.number}`, { state: 'closed' }).catch(
        () => undefined
      );
      await github('DELETE', `/repos/${repo}/git/refs/heads/${pull.head.ref}`).catch(
        () => undefined
      );
    });

    it(
      'opens a pull request for the ticket',
      async () => {
        const repo = liveEnv('LIVE_E2E_FIXTURE_REPO');
        const res = await fetch(`${liveEnv('LIVE_E2E_API_URL')}/api/v1/work-requests`, {
          body: JSON.stringify({
            description:
              'The test in test/sum.test.js fails because sum() in src/sum.js subtracts instead of ' +
              'adding. Fix sum() so `npm test` passes. Change nothing else.',
            externalTicketId: ticket,
            repoIds: [liveEnv('LIVE_E2E_REPO_ID')],
          }),
          headers: {
            authorization: `Bearer ${liveEnv('LIVE_E2E_TOKEN')}`,
            'content-type': 'application/json',
          },
          method: 'POST',
          redirect: 'error',
        });
        expect(res.status, await res.clone().text()).toBe(201);
        const accepted = (await res.json()) as { data: { workflowIds: string[] } };
        expect(accepted.data.workflowIds.length).toBeGreaterThan(0);

        pull = await until('a pull request for the ticket', PR_TIMEOUT_MS, async () => {
          const open = await github<GhPull[]>(
            'GET',
            `/repos/${repo}/pulls?state=open&per_page=50&sort=created&direction=desc`
          );
          return open.find((p) => p.head.ref.endsWith(ticket));
        });
        expect(pull.number).toBeGreaterThan(0);
      },
      PR_TIMEOUT_MS + 60_000
    );

    it(
      'heals CI: the pull request ends with every check green',
      async () => {
        const repo = liveEnv('LIVE_E2E_FIXTURE_REPO');
        expect(pull, 'the previous step opens the pull request').toBeDefined();
        const number = pull?.number as number;
        const seenHeads = new Set<string>();

        const finalHead = await until(
          'green CI on the pull request head',
          CI_TIMEOUT_MS,
          async () => {
            // The head moves when the platform's CI-fix loop pushes a follow-up commit.
            const current = await github<GhPull>('GET', `/repos/${repo}/pulls/${number}`);
            seenHeads.add(current.head.sha);
            const checks = await github<GhCheckRuns>(
              'GET',
              `/repos/${repo}/commits/${current.head.sha}/check-runs?per_page=100`
            );
            const runs = checks.check_runs;
            if (runs.length === 0 || runs.some((r) => r.status !== 'completed')) {
              return undefined;
            }
            const green = runs.every((r) =>
              ['success', 'neutral', 'skipped'].includes(r.conclusion ?? '')
            );
            // A red head is not final: the platform may still be fixing it. Keep polling until the
            // timeout, when the failure is reported with what was seen.
            return green ? current.head.sha : undefined;
          }
        );

        expect(finalHead).toMatch(/^[0-9a-f]{40}$/);
        // Not an assertion: whether the first push was already green or a fix commit followed is
        // worth seeing in the log of a scheduled run.
        console.info(`[live] CI green on ${finalHead} after ${seenHeads.size} head commit(s)`);
      },
      CI_TIMEOUT_MS + 60_000
    );
  }
);
