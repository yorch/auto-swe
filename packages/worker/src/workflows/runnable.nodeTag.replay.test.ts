/**
 * The node-tag interceptor must not change what a recorded run replays as.
 *
 * `runnable.replay.test.ts` replays the committed fixtures without it. These
 * histories were recorded before the interceptor existed, so replaying them WITH
 * it proves that adding headers to scheduled activities leaves the command
 * stream Temporal compares (type and order) untouched, which is the failure that
 * would strand an in-flight run on deploy. Fixtures are read, never rewritten.
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

describe('RunnableWorkflow — history replay with the node-tag interceptor', () => {
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
              workflowModules: [path.resolve(__dirname, './nodeTagInterceptor.ts')],
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
