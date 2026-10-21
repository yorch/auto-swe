import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  assertTargetsContainer,
  createTeardown,
  databaseUrl,
  EXPECTED,
  main,
  parseContainerRows,
  parsePublishedPort,
  selectStale,
  unexpectedDiff,
} from './check-migrations.mjs';

const MEMORY = 'DROP INDEX "idx_memory_items_embedding";';
const KNOWLEDGE = 'DROP INDEX "knowledge_items_embedding_hnsw_idx";';

describe('unexpectedDiff', () => {
  it('lists the same two statements as the CI step', () => {
    expect(EXPECTED).toEqual([MEMORY, KNOWLEDGE]);
  });

  it('accepts a diff holding only the two known statements, with comments and blanks', () => {
    const sql = ['-- DropIndex', MEMORY, '', '-- DropIndex', KNOWLEDGE, '   ', '--', ''].join('\n');
    expect(unexpectedDiff(sql)).toEqual([]);
  });

  it('accepts an empty diff', () => {
    expect(unexpectedDiff('')).toEqual([]);
  });

  it('reports any other statement', () => {
    const sql = [MEMORY, 'CREATE INDEX "x" ON "t"("c");', KNOWLEDGE].join('\n');
    expect(unexpectedDiff(sql)).toEqual(['CREATE INDEX "x" ON "t"("c");']);
  });

  it('matches whole lines only, as grep -x does', () => {
    expect(unexpectedDiff(`${MEMORY} -- trailing`)).toEqual([`${MEMORY} -- trailing`]);
    expect(unexpectedDiff(` ${MEMORY}`)).toEqual([` ${MEMORY}`]);
    expect(unexpectedDiff('DROP INDEX "idx_memory_items_embedding_other";')).toHaveLength(1);
  });

  it('does not let a comment prefix hide a statement on the same line', () => {
    expect(unexpectedDiff('-- ok\nDROP TABLE "users"; -- sneaky')).toEqual([
      'DROP TABLE "users"; -- sneaky',
    ]);
  });
});

describe('parsePublishedPort', () => {
  it('takes the IPv4 loopback mapping', () => {
    expect(parsePublishedPort('127.0.0.1:49153\n')).toBe(49153);
  });

  it('ignores other bindings', () => {
    expect(parsePublishedPort('0.0.0.0:49153\n[::]:49153\n')).toBeNull();
    expect(parsePublishedPort('')).toBeNull();
  });
});

describe('assertTargetsContainer', () => {
  it('accepts the container URL', () => {
    expect(() => assertTargetsContainer(databaseUrl(49153), 49153)).not.toThrow();
  });

  it('refuses another host, another port, localhost, or a missing URL', () => {
    expect(() => assertTargetsContainer('postgresql://u:p@db.internal:5432/app', 49153)).toThrow(
      /refusing to run/
    );
    expect(() => assertTargetsContainer('postgresql://u:p@127.0.0.1:5432/app', 49153)).toThrow(
      /refusing to run/
    );
    expect(() => assertTargetsContainer('postgresql://u:p@localhost:49153/app', 49153)).toThrow(
      /refusing to run/
    );
    expect(() => assertTargetsContainer(undefined, 49153)).toThrow(/missing/);
    expect(() => assertTargetsContainer('not a url', 49153)).toThrow(/missing/);
  });
});

describe('selectStale', () => {
  const now = 10_000_000_000;
  const alive = new Set([100]);
  const isAlive = (pid) => alive.has(pid);

  it('keeps a fresh container whose owner is alive: it is a concurrent run', () => {
    expect(selectStale([{ id: 'a', runLabel: `100-${now - 1000}` }], { isAlive, now })).toEqual([]);
  });

  it('removes one whose owner is gone, however fresh', () => {
    expect(selectStale([{ id: 'a', runLabel: `999-${now - 1000}` }], { isAlive, now })).toEqual([
      'a',
    ]);
  });

  it('removes one older than the limit even if the pid is alive', () => {
    const old = now - 31 * 60 * 1000;
    expect(selectStale([{ id: 'a', runLabel: `100-${old}` }], { isAlive, now })).toEqual(['a']);
  });

  it('removes a container with no readable run label', () => {
    expect(
      selectStale(
        [
          { id: 'a', runLabel: '' },
          { id: 'b', runLabel: 'garbage' },
        ],
        { isAlive, now }
      )
    ).toEqual(['a', 'b']);
  });
});

describe('parseContainerRows', () => {
  it('reads id and run label, tolerating a missing label', () => {
    expect(parseContainerRows('abc 12-34\ndef \n\n')).toEqual([
      { id: 'abc', runLabel: '12-34' },
      { id: 'def', runLabel: '' },
    ]);
  });
});

describe('createTeardown', () => {
  it('removes once, however many callers ask, and every caller waits for it', async () => {
    let release;
    const remove = vi.fn(() => new Promise((resolve) => (release = resolve)));
    const teardown = createTeardown(remove);
    const first = teardown();
    const second = teardown();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await Promise.all([first, second]);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

/** A scripted docker/yarn: `plan` overrides the answer for a matching command line. */
function harness(plan = {}) {
  const calls = [];
  const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const run = vi.fn(async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    for (const [pattern, answer] of Object.entries(plan)) {
      if (line.includes(pattern)) {
        return typeof answer === 'function' ? answer(line) : answer;
      }
    }
    const defaults = [
      ['docker info', ok('')],
      ['docker ps', ok('')],
      ['docker run', ok('containerid')],
      ['docker port', ok('127.0.0.1:41000\n')],
      ['docker inspect', ok('true\n')],
      ['pg_isready', ok('')],
      ['--input-type=module', ok(databaseUrl(41000))],
      ['migrate deploy', ok('applied')],
      ['psql', ok('3\n')],
      ['migrate diff', ok(`${EXPECTED.join('\n')}\n`)],
    ];
    const match = defaults.find(([pattern]) => line.includes(pattern));
    if (match) {
      return match[1];
    }
    return ok('');
  });
  const deps = {
    isAlive: () => false,
    migrationCount: () => 3,
    now: () => 1_000_000,
    pid: 4242,
    proc,
    run,
    sleep: async () => undefined,
  };
  return { calls, deps, proc };
}
const ok = (stdout) => ({ code: 0, stderr: '', stdout });
const fail = (stderr = 'boom') => ({ code: 1, stderr, stdout: '' });

describe('main', () => {
  it('exits 0 on a match, names and labels its container, and removes it by name', async () => {
    const { calls, deps } = harness();
    expect(await main(deps)).toBe(0);
    const start = calls.find((c) => c.startsWith('docker run'));
    expect(start).toContain('--name auto-swe-migcheck-4242-1000000');
    expect(start).toContain('--label auto-swe-migrations-check-run=4242-1000000');
    expect(start).not.toMatch(/ -v | --mount /);
    expect(calls).toContainEqual(expect.stringMatching(/^yarn node --input-type=module /));
    expect(calls.at(-1)).toBe('docker rm -fv auto-swe-migcheck-4242-1000000');
  });

  it('exits 1 and prints the unexpected SQL on drift', async () => {
    const { deps } = harness({ 'migrate diff': ok('CREATE INDEX "x" ON "t"("c");\n') });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(deps)).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('CREATE INDEX "x"');
    err.mockRestore();
  });

  it('exits 2 when docker is not usable, without starting anything', async () => {
    const { calls, deps } = harness({ 'docker info': fail() });
    expect(await main(deps)).toBe(2);
    expect(calls.some((c) => c.startsWith('docker run'))).toBe(false);
  });

  it('removes only stale labelled containers at start, never a live concurrent run', async () => {
    const { calls, deps } = harness({
      'docker ps': ok('dead 999-1000000\nlive 100-999000\n'),
    });
    deps.isAlive = (pid) => pid === 100;
    expect(await main(deps)).toBe(0);
    expect(calls).toContain('docker rm -fv dead');
    expect(calls.some((c) => c.startsWith('docker rm -fv') && c.includes('live'))).toBe(false);
  });

  it('reports exit 2, not drift, when deploy fails because the container is gone', async () => {
    let running = true;
    const { deps } = harness({
      'docker inspect': () => ok(running ? 'true\n' : 'false\n'),
      'migrate deploy': () => {
        running = false;
        return fail();
      },
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(deps)).toBe(2);
    err.mockRestore();
  });

  it('reports exit 1 when deploy fails against a healthy database', async () => {
    const { deps } = harness({ 'migrate deploy': fail('bad sql') });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(deps)).toBe(1);
    err.mockRestore();
  });

  it('reports exit 2 when the diff fails because the database is unreachable', async () => {
    let ready = true;
    const { deps } = harness({
      'migrate diff': () => {
        ready = false;
        return fail();
      },
      pg_isready: () => (ready ? ok('') : fail()),
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(deps)).toBe(2);
    err.mockRestore();
  });

  it('aborts with exit 2 before migrating when prisma would connect elsewhere', async () => {
    const { calls, deps } = harness({
      '--input-type=module': ok('postgresql://u:p@db.internal:5432/app'),
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(deps)).toBe(2);
    err.mockRestore();
    expect(calls.some((c) => c.includes('migrate deploy'))).toBe(false);
    expect(calls.at(-1)).toContain('docker rm -fv');
  });

  it('exits 2 when the deploy did not reach the container', async () => {
    const { deps } = harness({ psql: ok('0\n') });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await main(deps)).toBe(2);
    err.mockRestore();
  });

  it('removes the container by name on a signal, and a second signal does not skip or repeat it', async () => {
    let release;
    const { calls, deps, proc } = harness({
      'migrate deploy': () => new Promise((resolve) => (release = () => resolve(ok('')))),
    });
    const done = main(deps);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    proc.emit('SIGINT');
    proc.emit('SIGINT');
    await vi.waitFor(() => expect(proc.exit).toHaveBeenCalledTimes(2));
    expect(proc.exit).toHaveBeenCalledWith(130);
    expect(calls.filter((c) => c.startsWith('docker rm -fv auto-swe-migcheck'))).toHaveLength(1);
    release();
    await done;
  });
});
