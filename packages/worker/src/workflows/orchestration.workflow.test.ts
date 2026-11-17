/**
 * OrchestrationWorkflow under Temporal's time-skipping test server, with every activity replaced
 * by an in-process fake: event batching, turn -> apply -> wait, the child-finished signal, the
 * lost-signal backstop, idle completion only with nothing in flight, cancel, the turn limit and
 * `continueAsNew` carrying the queue. Network-restricted environments skip via the beforeEach guard.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORCHESTRATION_SIGNALS, orchestrationWorkflowId } from '@auto-swe/shared/lib/orchestration';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { DefaultLogger, Runtime, Worker } from '@temporalio/worker';
import type { TestContext } from 'vitest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  OrchestrationEvent,
  OrchestrationWorkflowInput,
  OrchestratorIntent,
  RunOrchestratorTurnInput,
} from '../lib/orchestrationTypes.js';
import {
  approvalResolvedSignal,
  attachResolvedSignal,
  childFinishedSignal,
  OrchestrationWorkflow,
  orchestrationCancelSignal,
  userMessageSignal,
} from './index.js';

const TASK_QUEUE = 'orchestration-workflow-test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Everything the fakes saw and everything a test scripts. */
const log = {
  applied: [] as { intents: OrchestratorIntent[]; turnKey: string }[],
  begun: 0,
  cancelled: 0,
  refreshed: 0,
  statuses: [] as { status: string; code?: string }[],
  turnKeys: [] as string[],
  turns: [] as OrchestrationEvent[][],
};
const script = {
  /** After this many refreshes the fake reports a finished child. */
  afterRefresh: (_n: number): { finished: string[]; running: number } => ({
    finished: [],
    running: 0,
  }),
  applyResult: (_n: number): { refused: number; running: number } => ({ refused: 0, running: 0 }),
  begin: { delayMs: 0, proceed: true, running: 0, turns: 0, unseen: [] as string[] },
  onTurn: (_n: number, _input: RunOrchestratorTurnInput): void => {},
  turnIntents: (_n: number): OrchestratorIntent[] => [],
  turnRunning: (_n: number): number => 0,
};

let env: TestWorkflowEnvironment | undefined;
let worker: Worker | undefined;
let workerRun: Promise<void> | undefined;
let currentId = '';

const fakeActivities = {
  applyOrchestrationIntents: async (input: { intents: OrchestratorIntent[]; turnKey: string }) => {
    log.applied.push({ intents: input.intents, turnKey: input.turnKey });
    const r = script.applyResult(log.applied.length);
    return {
      pendingApprovals: 0,
      pendingAttach: false,
      refused: r.refused,
      runningChildren: r.running,
      spawned: 0,
      wait: r.running > 0,
    };
  },
  beginOrchestrationRun: async () => {
    log.begun += 1;
    if (script.begin.delayMs) {
      await new Promise((r) => setTimeout(r, script.begin.delayMs));
    }
    return {
      // The test server's clock, which time skipping moves ahead of the wall clock.
      createdAtMs: await (env as TestWorkflowEnvironment).currentTimeMs(),
      pendingApprovals: 0,
      proceed: script.begin.proceed,
      runningChildren: script.begin.running,
      turns: script.begin.turns,
      unseenChildIds: script.begin.unseen,
    };
  },
  cancelOrchestrationChildren: async () => {
    log.cancelled += 1;
    return { cancelled: 0 };
  },
  recordOrchestrationStatus: async (input: { status: string; notice?: { code: string } }) => {
    log.statuses.push({ code: input.notice?.code, status: input.status });
  },
  refreshOrchestrationChildren: async () => {
    log.refreshed += 1;
    const r = script.afterRefresh(log.refreshed);
    return { finishedChildIds: r.finished, pendingApprovals: 0, runningChildren: r.running };
  },
  runOrchestratorTurn: async (input: RunOrchestratorTurnInput) => {
    log.turns.push(input.events);
    log.turnKeys.push(input.turnKey);
    const n = log.turns.length;
    script.onTurn(n, input);
    return {
      intents: script.turnIntents(n),
      pendingApprovals: 0,
      runningChildren: script.turnRunning(n),
      status: 'COMPLETE' as const,
    };
  },
};

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('ERROR') });
  try {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  } catch (e) {
    if (/Failed to start ephemeral server|Forbidden|ECONNREFUSED/.test(String(e))) {
      return;
    }
    throw e;
  }
  worker = await Worker.create({
    activities: fakeActivities,
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUE,
    workflowsPath: path.resolve(__dirname, './index.ts'),
  });
  workerRun = worker.run();
}, 240_000);

beforeEach((ctx: TestContext) => {
  if (!env || !worker) {
    ctx.skip();
  }
  log.applied = [];
  log.begun = 0;
  log.cancelled = 0;
  log.refreshed = 0;
  log.statuses = [];
  log.turns = [];
  log.turnKeys = [];
  script.afterRefresh = () => ({ finished: [], running: 0 });
  script.applyResult = () => ({ refused: 0, running: 0 });
  script.begin = { delayMs: 0, proceed: true, running: 0, turns: 0, unseen: [] };
  script.onTurn = () => {};
  script.turnIntents = () => [];
  script.turnRunning = () => 0;
});

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await env?.teardown();
}, 60_000);

let seq = 0;
function input(over: Partial<OrchestrationWorkflowInput> = {}): OrchestrationWorkflowInput {
  seq += 1;
  currentId = `0b1c2d3e-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  return {
    orchestrationId: currentId,
    pinned: {
      maxChildren: 12,
      maxConcurrentChildren: 4,
      maxTurns: 200,
      maxWallClockSeconds: 14_400,
      maxWriterChildren: 4,
    },
    teamId: 'team-1',
    token: 'orch_token',
    userId: 'user-1',
    ...over,
  };
}

async function start(wfInput: OrchestrationWorkflowInput, messageId = 'm1') {
  const client = (env as TestWorkflowEnvironment).client;
  return client.workflow.signalWithStart('OrchestrationWorkflow', {
    args: [wfInput],
    signal: ORCHESTRATION_SIGNALS.userMessage,
    signalArgs: [{ messageId }],
    taskQueue: TASK_QUEUE,
    workflowExecutionTimeout: '48 hours',
    workflowId: orchestrationWorkflowId(wfInput.orchestrationId),
  });
}

const spawn: OrchestratorIntent = {
  intent: { agent: 'docsMaintainer', label: 'read docs', role: 'reader', task: 'read' },
  kind: 'spawn',
};

describe('OrchestrationWorkflow', () => {
  it('is started and signalled by the names the gateway uses', () => {
    expect(OrchestrationWorkflow.name).toBe('OrchestrationWorkflow');
    expect(userMessageSignal.name).toBe(ORCHESTRATION_SIGNALS.userMessage);
    expect(childFinishedSignal.name).toBe(ORCHESTRATION_SIGNALS.childFinished);
    expect(attachResolvedSignal.name).toBe(ORCHESTRATION_SIGNALS.attachResolved);
    expect(approvalResolvedSignal.name).toBe(ORCHESTRATION_SIGNALS.approvalResolved);
    expect(orchestrationCancelSignal.name).toBe(ORCHESTRATION_SIGNALS.cancel);
  });

  it('batches events that arrive together into one turn, then idles to WAITING', async () => {
    script.begin.delayMs = 400;
    const handle = await start(input());
    await handle.signal(ORCHESTRATION_SIGNALS.userMessage, { messageId: 'm2' });
    await handle.signal(ORCHESTRATION_SIGNALS.attachResolved, {
      accepted: true,
      messageId: 'a1',
      repoId: 'r1',
    });
    await handle.result();
    expect(log.turns).toHaveLength(1);
    expect(log.turns[0]?.map((e) => e.type)).toEqual([
      'userMessage',
      'userMessage',
      'attachResolved',
    ]);
    expect(log.statuses.at(-1)).toMatchObject({ status: 'WAITING' });
    expect(log.cancelled).toBe(0);
  });

  it('applies the intents a turn returned, in order, with the turn key', async () => {
    const second: OrchestratorIntent = { intent: { childId: 'c1' }, kind: 'cancel' };
    script.turnIntents = () => [spawn, second];
    const handle = await start(input());
    await handle.result();
    expect(log.applied).toHaveLength(1);
    expect(log.applied[0]?.intents).toEqual([spawn, second]);
    expect(log.applied[0]?.turnKey).toMatch(new RegExp(`^${currentId}-[0-9a-f]{8}-t1$`));
  });

  it('waits while a child runs, and takes the childFinished signal as the next turn', async () => {
    script.turnRunning = (n) => (n === 1 ? 1 : 0);
    script.turnIntents = (n) => (n === 1 ? [spawn] : []);
    script.applyResult = () => ({ refused: 0, running: 1 });
    const handle = await start(input());
    await new Promise((r) => setTimeout(r, 600));
    expect(log.turns).toHaveLength(1);
    expect(log.statuses.some((s) => s.status === 'WAITING')).toBe(false);
    await handle.signal(ORCHESTRATION_SIGNALS.childFinished, { childId: 'c1' });
    // The finish turn reports nothing running, so the workflow idles out.
    script.afterRefresh = () => ({ finished: [], running: 0 });
    await handle.result();
    expect(log.turns).toHaveLength(2);
    expect(log.turns[1]).toEqual([{ childId: 'c1', type: 'childFinished' }]);
    expect(log.statuses.at(-1)).toMatchObject({ status: 'WAITING' });
  });

  it('reconciles a lost childFinished signal with the polling backstop', async () => {
    script.turnRunning = (n) => (n === 1 ? 1 : 0);
    script.applyResult = () => ({ refused: 0, running: 1 });
    script.turnIntents = (n) => (n === 1 ? [spawn] : []);
    // The third refresh finds the child finished; no signal was ever sent.
    script.afterRefresh = (n) =>
      n >= 3 ? { finished: ['c9'], running: 0 } : { finished: [], running: 1 };
    const handle = await start(input());
    await handle.result();
    expect(log.refreshed).toBe(3);
    expect(log.turns[1]).toEqual([{ childId: 'c9', type: 'childFinished' }]);
    expect(log.statuses.at(-1)).toMatchObject({ status: 'WAITING' });
  });

  it('does not complete while a child is still running, and cancel stops it', async () => {
    script.turnRunning = () => 1;
    script.afterRefresh = (n) => {
      if (n === 4) {
        void (env as TestWorkflowEnvironment).client.workflow
          .getHandle(orchestrationWorkflowId(currentId))
          .signal(ORCHESTRATION_SIGNALS.cancel);
      }
      return { finished: [], running: 1 };
    };
    const handle = await start(input());
    await handle.result();
    expect(log.refreshed).toBeGreaterThanOrEqual(4);
    expect(log.statuses.some((s) => s.status === 'WAITING')).toBe(false);
    expect(log.cancelled).toBe(1);
    expect(log.statuses.at(-1)).toMatchObject({ status: 'CANCELLED' });
  });

  it('cancels running children and ends CANCELLED on the cancel signal', async () => {
    script.begin.delayMs = 300;
    script.begin.running = 2;
    const handle = await start(input());
    await handle.signal(ORCHESTRATION_SIGNALS.cancel);
    await handle.result();
    expect(log.cancelled).toBe(1);
    expect(log.statuses.at(-1)).toMatchObject({ status: 'CANCELLED' });
  });

  it('stops at the pinned turn limit and says so', async () => {
    script.onTurn = (n) => {
      if (n === 1) {
        void (env as TestWorkflowEnvironment).client.workflow
          .getHandle(orchestrationWorkflowId(currentId))
          .signal(ORCHESTRATION_SIGNALS.userMessage, { messageId: 'again' });
      }
    };
    const handle = await start(input({ pinned: { ...input().pinned, maxTurns: 1 } }));
    await handle.result();
    expect(log.turns).toHaveLength(1);
    expect(log.cancelled).toBe(1);
    expect(log.statuses.at(-1)).toEqual({ code: 'TURN_LIMIT_REACHED', status: 'COMPLETED' });
  });

  it('wakes the orchestrator once to read refusals, at most three times in a row', async () => {
    script.turnIntents = () => [spawn];
    script.applyResult = () => ({ refused: 1, running: 0 });
    const handle = await start(input());
    await handle.result();
    // The person's turn, then three notice turns, then it waits for a person.
    expect(log.turns).toHaveLength(4);
    expect(log.turns[1]).toEqual([{ type: 'notices' }]);
    expect(log.turns[3]).toEqual([{ type: 'notices' }]);
  });

  it('does nothing for a start after the orchestration is over', async () => {
    script.begin.proceed = false;
    const handle = await start(input());
    await handle.result();
    expect(log.turns).toHaveLength(0);
    expect(log.statuses).toHaveLength(0);
  });

  it('keys turns apart across a restart that reads a smaller turn count', async () => {
    // Two fresh executions of one orchestration (the first ended idle) both start from a database
    // count of 0 turns because the earlier turns posted no text.
    script.begin.turns = 0;
    const first = await start(input());
    await first.result();
    const keysOne = [...log.turnKeys];
    log.turnKeys.length = 0;
    const handle = await start(input(), 'm2');
    await handle.result();
    expect(log.turnKeys).toHaveLength(keysOne.length);
    for (const key of log.turnKeys) {
      expect(keysOne).not.toContain(key);
    }
  });

  it('reports finished children a restarted execution finds unread', async () => {
    script.begin.unseen = ['c5'];
    const handle = await start(input());
    await handle.result();
    expect(log.turns[0]?.map((e) => e.type)).toEqual(['userMessage', 'childFinished']);
  });

  it('continues as new every 50 turns, carrying the queue and not starting again', async () => {
    let sent = 0;
    script.onTurn = (n) => {
      if (n < 52) {
        sent += 1;
        void (env as TestWorkflowEnvironment).client.workflow
          .getHandle(orchestrationWorkflowId(currentId))
          .signal(ORCHESTRATION_SIGNALS.userMessage, { messageId: `m-${n}` });
      }
    };
    const handle = await start(input());
    await handle.result();
    expect(sent).toBe(51);
    expect(log.turns).toHaveLength(52);
    // `beginOrchestrationRun` ran once: the later executions resumed from the carried state.
    expect(log.begun).toBe(1);
    // Every turn key is distinct and shares one epoch across the continue-as-new, so a retried
    // apply reuses its key and no later turn can collide with an earlier one.
    expect(new Set(log.turnKeys).size).toBe(52);
    expect(new Set(log.turnKeys.map((k) => k.split('-').at(-2))).size).toBe(1);
    expect(log.turnKeys[51]).toMatch(/-t52$/);
    // The signal sent during turn 50 rode across the continue-as-new.
    expect(log.turns[50]?.[0]).toEqual({ messageId: 'm-50', type: 'userMessage' });
  }, 120_000);
});
