/**
 * The committed fixtures replayed with the worker's full set of workflow
 * interceptors — the node-tag one and the trace-context one — as `index.ts`
 * registers them. Both only add headers, which the replay comparison ignores;
 * this proves it for every recorded control-flow shape. Fixtures are read,
 * never rewritten. (`traceContext.workflow.test.ts` covers the other direction:
 * a history recorded with a trace header, replayed with and without it.)
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import proto from '@temporalio/proto';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import { beforeAll, describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, './__fixtures__');

const fixtures = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.bin'))
  .sort()
  .map((file) => ({
    history: proto.temporal.api.history.v1.History.decode(
      readFileSync(path.join(FIXTURE_DIR, file))
    ),
    name: path.basename(file, '.bin'),
  }));

beforeAll(() => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
});

describe('RunnableWorkflow — history replay with every workflow interceptor', () => {
  it('finds the fixtures', () => {
    expect(fixtures.length).toBeGreaterThan(10);
  });

  it.each(fixtures)(
    'replays $name without a determinism violation',
    async ({ history }) => {
      await expect(
        Worker.runReplayHistory(
          {
            interceptors: {
              workflowModules: [
                path.resolve(__dirname, './nodeTagInterceptor.ts'),
                path.resolve(__dirname, './traceContextInterceptor.ts'),
              ],
            },
            workflowsPath: path.resolve(__dirname, './index.ts'),
          },
          history
        )
      ).resolves.toBeUndefined();
    },
    120_000
  );
});
