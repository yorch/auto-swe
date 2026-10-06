import { IMPLEMENTER_RUNTIMES } from '@auto-swe/shared/types/api';
import { describe, expect, it, vi } from 'vitest';
import { HARNESSES } from '../harnessRegistry.js';
import { createHarnessRegistry, defineHarness, type HarnessKind } from './registry.js';

function harness(enforces: boolean, kind = 'claude-code' as HarnessKind) {
  const createRuntime = vi.fn((options: unknown) => ({ options, runTurn: vi.fn() }));
  const bindModel = vi.fn((_agentKey: string, model: { spec: string }) => ({ id: model.spec }));
  return {
    bindModel,
    createRuntime,
    registered: defineHarness({
      bindModel,
      capabilities: { enforcesPerCallPolicyInWorker: enforces },
      createRuntime,
      kind,
      label: 'Some Harness',
    }),
  };
}

describe('createHarnessRegistry', () => {
  it('refuses, at registration, a harness that cannot enforce the per-call policy', () => {
    expect(() => createHarnessRegistry([harness(false).registered])).toThrow(
      expect.objectContaining({ nonRetryable: true, type: 'HARNESS_POLICY_UNENFORCEABLE' })
    );
  });

  it('refuses two harnesses for one kind', () => {
    expect(() =>
      createHarnessRegistry([harness(true).registered, harness(true).registered])
    ).toThrow(/Two harnesses/);
  });

  it('refuses at selection a harness whose capability no longer holds', () => {
    const { registered } = harness(true);
    const registry = createHarnessRegistry([registered]);
    registered.capabilities.enforcesPerCallPolicyInWorker = false;
    expect(() => registry.select('claude-code')).toThrow(
      expect.objectContaining({ type: 'HARNESS_POLICY_UNENFORCEABLE' })
    );
  });

  it('refuses, without retrying, a kind nothing serves', () => {
    const registry = createHarnessRegistry([]);
    expect(() => registry.select('claude-code')).toThrow(
      expect.objectContaining({ nonRetryable: true, type: 'HARNESS_UNAVAILABLE' })
    );
  });

  it('binds the Agent’s model before building the runtime on it', () => {
    const { bindModel, createRuntime, registered } = harness(true);
    const registry = createHarnessRegistry([registered]);
    const options = { loadProjectSettings: true, maxTurns: 3, tracer: {}, workspace: {} } as never;

    registry.select('claude-code').bind('ciFixer', { apiKey: 'k', spec: 'p/m' }).build(options);

    expect(bindModel).toHaveBeenCalledWith('ciFixer', { apiKey: 'k', spec: 'p/m' });
    expect(createRuntime).toHaveBeenCalledWith({
      access: { id: 'p/m' },
      loadProjectSettings: true,
      maxTurns: 3,
      tracer: {},
      workspace: {},
    });
  });

  it('builds nothing when the model cannot be bound', () => {
    const { bindModel, createRuntime, registered } = harness(true);
    bindModel.mockImplementation(() => {
      throw new Error('unsupported model');
    });
    expect(() =>
      createHarnessRegistry([registered])
        .select('claude-code')
        .bind('a', { apiKey: 'k', spec: 'x' })
    ).toThrow(/unsupported model/);
    expect(createRuntime).not.toHaveBeenCalled();
  });
});

describe('the worker’s harnesses', () => {
  it('serve every implementer runtime other than the Mastra loop', () => {
    const harnessKinds = IMPLEMENTER_RUNTIMES.filter((k) => k !== 'mastra');
    expect(HARNESSES.kinds().sort()).toEqual([...harnessKinds].sort());
    for (const kind of harnessKinds) {
      expect(HARNESSES.select(kind).capabilities.enforcesPerCallPolicyInWorker).toBe(true);
    }
  });
});
