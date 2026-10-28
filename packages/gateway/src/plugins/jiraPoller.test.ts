import Fastify from 'fastify';
import fp from 'fastify-plugin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PollOutcome } from '../lib/automations/jiraPoller.js';
import jiraPollerPlugin, {
  createPollLoop,
  type PollRow,
  type PollTickDeps,
  pollAllJiraAutomations,
} from './jiraPoller.js';

const log = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() });

describe('createPollLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const loopWith = (over: Partial<Parameters<typeof createPollLoop>[0]> = {}) => {
    const tick = vi.fn(async () => {});
    const readIntervalSeconds = vi.fn(async () => 120);
    const l = log();
    const loop = createPollLoop({
      firstDelayMs: 10_000,
      log: l,
      readIntervalSeconds,
      tick,
      ...over,
    });
    return { l, loop, readIntervalSeconds, tick };
  };

  it('waits the first delay, then one interval after each tick ends', async () => {
    const { loop, tick } = loopWith();
    loop.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('counts the interval from the end of a slow tick, so ticks never overlap', async () => {
    let running = 0;
    let overlapped = false;
    const tick = vi.fn(async () => {
      running++;
      overlapped ||= running > 1;
      await new Promise((r) => setTimeout(r, 200_000));
      running--;
    });
    const { loop } = loopWith({ tick });
    loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
    // The interval (120 s) passes while the first tick is still running: no second tick yet.
    await vi.advanceTimersByTimeAsync(150_000);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50_000 + 119_000);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(overlapped).toBe(false);
    loop.stop();
  });

  it('reads the interval again before each wait, so a change applies from the next one', async () => {
    const intervals = [120, 60];
    const readIntervalSeconds = vi.fn(async () => intervals.shift() ?? 60);
    const { loop, tick } = loopWith({ readIntervalSeconds });
    loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(3);
    loop.stop();
  });

  it('keeps going after a tick fails, and logs it', async () => {
    const tick = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const { l, loop } = loopWith({ tick });
    loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(l.error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tick).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('falls back to five minutes when the interval cannot be read', async () => {
    const readIntervalSeconds = vi.fn(async () => {
      throw new Error('db down');
    });
    const { loop, tick } = loopWith({ readIntervalSeconds });
    loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    loop.stop();
  });

  it('stops: no tick after stop, whether it was waiting or running', async () => {
    const { loop, tick } = loopWith();
    loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    loop.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(tick).toHaveBeenCalledTimes(1);

    const slow = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 1_000));
    });
    const second = loopWith({ tick: slow });
    second.loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    second.loop.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('does not schedule another tick when it is stopped while the interval is being read', async () => {
    let release: (seconds: number) => void = () => {};
    const readIntervalSeconds = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        })
    );
    const { loop, tick } = loopWith({ readIntervalSeconds });
    loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(tick).toHaveBeenCalledTimes(1);
    loop.stop();
    release(60);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('stop() waits for the tick that is running, so what it uses is still open', async () => {
    let finish: () => void = () => {};
    let finished = false;
    const tick = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            finished = true;
            resolve();
          };
        })
    );
    const { loop } = loopWith({ tick });
    loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    let stopSettled = false;
    const stopping = loop.stop().then(() => {
      stopSettled = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stopSettled).toBe(false);
    finish();
    await stopping;
    expect(finished).toBe(true);
  });

  it('stop() resolves at once when nothing is running', async () => {
    const { loop } = loopWith();
    loop.start();
    await expect(loop.stop()).resolves.toBeUndefined();
  });

  it('reports whether it was stopped', () => {
    const { loop } = loopWith();
    expect(loop.stopped()).toBe(false);
    loop.stop();
    expect(loop.stopped()).toBe(true);
  });
});

describe('pollAllJiraAutomations', () => {
  const row = (id: string, over: Record<string, unknown> = {}): PollRow =>
    ({
      connection: {
        githubUrl: null,
        id: `conn-${id}`,
        installation: null,
        isActive: true,
        organizationName: 'acme',
        repoName: `api-${id}`,
        team: { id: 'team-1', orgId: 'org-1' },
      },
      cooldownMinutes: 0,
      enabled: true,
      filters: { jql: 'status = Open' },
      id,
      inputs: {},
      maxRunsPerDay: 10,
      source: 'jira.filter.new_issue',
      templateId: null,
      ...over,
    }) as unknown as PollRow;

  const polled: PollOutcome = { pending: 0, started: 0, status: 'polled', suppressed: 0 };
  const tracker = { fetchIssue: vi.fn(), searchIssues: vi.fn() };

  const deps = (over: Partial<PollTickDeps> = {}): PollTickDeps => ({
    instanceBaseUrl: vi.fn(async () => 'https://github.com'),
    listAutomations: vi.fn(async () => [row('a'), row('b')]),
    markAttempted: vi.fn(async () => {}),
    poll: vi.fn(async () => polled),
    reload: vi.fn(async (id: string) => row(id)),
    shouldStop: () => false,
    tracker: vi.fn(async () => tracker as never),
    ...over,
  });
  const fastify = () => ({ log: log(), prisma: {} }) as never;

  it('does nothing, and lists nothing, when the tracker is not Jira or not configured', async () => {
    const d = deps({ tracker: vi.fn(async () => null) });
    const result = await pollAllJiraAutomations(fastify(), d);
    expect(result).toEqual({ failed: 0, polled: 0, skipped: 0 });
    expect(d.listAutomations).not.toHaveBeenCalled();
    expect(d.poll).not.toHaveBeenCalled();
  });

  it('polls each automation with its own id, filters, repository and decider', async () => {
    const d = deps();
    const result = await pollAllJiraAutomations(fastify(), d);
    expect(result).toEqual({ failed: 0, polled: 2, skipped: 0 });
    const calls = (d.poll as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map(([, a]) => a.id)).toEqual(['a', 'b']);
    expect(calls[0]?.[1]).toMatchObject({
      connection: { id: 'conn-a' },
      filters: { jql: 'status = Open' },
    });
    expect(typeof calls[0]?.[0].decide).toBe('function');
    expect(calls[0]?.[0].tracker).toBe(tracker);
  });

  it('tells the poll which source each automation is, so a status-change one compares statuses', async () => {
    const d = deps({
      listAutomations: vi.fn(async () => [
        row('a'),
        row('b', { source: 'jira.filter.status_changed' }),
      ]),
      reload: vi.fn(async (id: string) =>
        row(id, id === 'b' ? { source: 'jira.filter.status_changed' } : {})
      ),
    });
    await pollAllJiraAutomations(fastify(), d);
    const calls = (d.poll as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map(([, a]) => a.source)).toEqual([
      'jira.filter.new_issue',
      'jira.filter.status_changed',
    ]);
  });

  it('stops starting new automations once the tick has used its time budget, and says how many wait', async () => {
    let clock = 0;
    const poll = vi.fn(async () => {
      clock += 6 * 60_000;
      return polled;
    });
    const f = fastify() as unknown as { log: { warn: ReturnType<typeof vi.fn> } };
    const d = deps({
      budgetMs: 10 * 60_000,
      clock: () => clock,
      listAutomations: vi.fn(async () => [row('a'), row('b'), row('c'), row('d')]),
      poll,
    });
    const result = await pollAllJiraAutomations(f as never, d);
    // 'a' ends at 6 min, 'b' at 12 min: over the budget, so 'c' and 'd' wait for the next tick.
    expect(poll).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ failed: 0, polled: 2, skipped: 0 });
    expect(f.log.warn).toHaveBeenCalledWith(
      { waiting: 2 },
      'the Jira poll tick used its time budget; the rest wait for the next tick'
    );
  });

  it('gives up on a poll that never settles, so one hung call does not stop the others', async () => {
    vi.useFakeTimers();
    try {
      const poll = vi
        .fn()
        .mockImplementationOnce(() => new Promise<PollOutcome>(() => {}))
        .mockResolvedValueOnce(polled);
      const f = fastify() as unknown as { log: { error: ReturnType<typeof vi.fn> } };
      const running = pollAllJiraAutomations(f as never, deps({ deadlineMs: 5_000, poll }));
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await running;
      expect(result).toEqual({ failed: 1, polled: 1, skipped: 0 });
      expect(poll).toHaveBeenCalledTimes(2);
      expect(f.log.error).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls an automation as it is when its turn comes, not as it was when the tick listed it', async () => {
    const reload = vi.fn(async (id: string) =>
      row(id, { filters: { jql: 'status = Blocked' }, maxRunsPerDay: 1 })
    );
    const d = deps({ reload });
    await pollAllJiraAutomations(fastify(), d);
    const calls = (d.poll as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]?.[1].filters).toEqual({ jql: 'status = Blocked' });
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['removed', async () => null],
    ['switched off', async (id: string) => row(id, { enabled: false })],
  ])('skips an automation that was %s after the tick listed it', async (_label, reload) => {
    const d = deps({ reload: vi.fn(reload) });
    const result = await pollAllJiraAutomations(fastify(), d);
    expect(d.poll).not.toHaveBeenCalled();
    expect(result).toEqual({ failed: 0, polled: 0, skipped: 2 });
  });

  it('marks a poll that failed as attempted, so it does not stay first in line', async () => {
    const poll = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(polled);
    const d = deps({ poll });
    await pollAllJiraAutomations(fastify(), d);
    expect(d.markAttempted).toHaveBeenCalledTimes(1);
    expect(d.markAttempted).toHaveBeenCalledWith('a');
  });

  it('does the same for a poll abandoned at its deadline', async () => {
    vi.useFakeTimers();
    try {
      const poll = vi.fn().mockImplementationOnce(() => new Promise<PollOutcome>(() => {}));
      const d = deps({ deadlineMs: 5_000, poll });
      const running = pollAllJiraAutomations(fastify(), d);
      await vi.advanceTimersByTimeAsync(5_000);
      await running;
      expect(d.markAttempted).toHaveBeenCalledWith('a');
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes on with the others when one automation’s poll throws, and logs it', async () => {
    const poll = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(polled);
    const f = fastify() as unknown as { log: { error: ReturnType<typeof vi.fn> } };
    const result = await pollAllJiraAutomations(f as never, deps({ poll }));
    expect(result).toEqual({ failed: 1, polled: 1, skipped: 0 });
    expect(f.log.error).toHaveBeenCalledTimes(1);
  });

  it('skips an automation whose repository names no owner, and polls the rest', async () => {
    const bad = row('a');
    (bad.connection as { organizationName: string | null }).organizationName = null;
    const d = deps({
      listAutomations: vi.fn(async () => [bad, row('b')]),
      reload: vi.fn(async (id: string) => (id === 'a' ? bad : row(id))),
    });
    const f = fastify() as unknown as { log: { warn: ReturnType<typeof vi.fn> } };
    const result = await pollAllJiraAutomations(f as never, d);
    expect(result).toEqual({ failed: 0, polled: 1, skipped: 1 });
    expect(f.log.warn).toHaveBeenCalledTimes(1);
  });

  it('logs one line with the counts when a tick handled an automation, and none when idle', async () => {
    const f = fastify() as unknown as { log: { info: ReturnType<typeof vi.fn> } };
    await pollAllJiraAutomations(f as never, deps());
    expect(f.log.info).toHaveBeenCalledTimes(1);
    expect(f.log.info).toHaveBeenCalledWith(
      { failed: 0, polled: 2, skipped: 0 },
      'Jira filter poll'
    );

    const idle = fastify() as unknown as { log: { info: ReturnType<typeof vi.fn> } };
    await pollAllJiraAutomations(idle as never, deps({ listAutomations: vi.fn(async () => []) }));
    await pollAllJiraAutomations(idle as never, deps({ tracker: vi.fn(async () => null) }));
    expect(idle.log.info).not.toHaveBeenCalled();
  });

  it('stops between automations when asked to', async () => {
    let calls = 0;
    const d = deps({
      poll: vi.fn(async () => {
        calls++;
        return polled;
      }),
      shouldStop: () => calls >= 1,
    });
    const result = await pollAllJiraAutomations(fastify(), d);
    expect(result.polled).toBe(1);
  });

  it('counts a poll that skipped itself, a switched-off team say, as skipped', async () => {
    const d = deps({
      poll: vi.fn(
        async (): Promise<PollOutcome> => ({ reason: 'switched-off', status: 'skipped' })
      ),
    });
    const result = await pollAllJiraAutomations(fastify(), d);
    expect(result).toEqual({ failed: 0, polled: 0, skipped: 2 });
  });
});

describe('the jira-poller plugin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A stand-in for the real prisma plugin, which would open a database connection.
  const prismaStub = fp(
    async (app) => {
      app.decorate('prisma', {} as never);
    },
    { name: 'prisma' }
  );

  it('needs the prisma plugin, and starts no timer until it is registered after it', async () => {
    const app = Fastify();
    await expect(app.register(jiraPollerPlugin).ready()).rejects.toThrow(/prisma/);
    await app.close().catch(() => {});
  });

  it('stops its loop when the server closes', async () => {
    const app = Fastify();
    await app.register(prismaStub);
    await app.register(jiraPollerPlugin, { firstDelayMs: 60_000 });
    await app.ready();
    expect(vi.getTimerCount()).toBe(1);
    await app.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
