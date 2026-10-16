import { describe, expect, it } from 'vitest';
import {
  findAuthoredCommandNodes,
  findContainerCodeNodes,
  hasAuthoredCode,
  hasAuthoredCommand,
  hasContainerCodeNode,
  isAuthoredCommandNode,
  isCommandGateStep,
  isContainerCodeNode,
  isShellCategoryStep,
} from './containerCode.js';
import type { Node, WorkflowSpec } from './spec.js';
import { listAllSteps } from './stepRegistry.js';

const spec = (nodes: Record<string, unknown>) =>
  ({ entry: 'a', name: 'x', nodes, schemaVersion: 1 }) as unknown as WorkflowSpec;

const node = (n: Record<string, unknown>) => n as unknown as Node;

describe('isShellCategoryStep', () => {
  it('is true for runContainerStep and false for other registered steps', () => {
    expect(isShellCategoryStep('runContainerStep')).toBe(true);
    expect(isShellCategoryStep('runLint')).toBe(false);
    expect(isShellCategoryStep('executeImplementation')).toBe(false);
  });

  it('is false for an unregistered step name rather than throwing', () => {
    expect(isShellCategoryStep('noSuchStep')).toBe(false);
  });

  it('matches step names exactly, not case-insensitively', () => {
    expect(isShellCategoryStep('RunContainerStep')).toBe(false);
  });

  it('agrees with the registry for every registered step', () => {
    for (const s of listAllSteps()) {
      expect(isShellCategoryStep(s.name)).toBe(s.category === 'shell');
    }
  });
});

describe('isContainerCodeNode', () => {
  it('covers all three spellings of container code', () => {
    expect(isContainerCodeNode(node({ command: 'x', image: 'alpine:latest', type: 'shell' }))).toBe(
      true
    );
    expect(isContainerCodeNode(node({ image: 'alpine:latest', type: 'containerStep' }))).toBe(true);
    expect(
      isContainerCodeNode(
        node({ config: { image: 'alpine:latest' }, step: 'runContainerStep', type: 'step' })
      )
    ).toBe(true);
  });

  it('ignores ordinary steps, unknown steps, and other node types', () => {
    expect(isContainerCodeNode(node({ step: 'runLint', type: 'step' }))).toBe(false);
    expect(isContainerCodeNode(node({ step: 'noSuchStep', type: 'step' }))).toBe(false);
    expect(isContainerCodeNode(node({ status: 'SUCCESS', type: 'terminate' }))).toBe(false);
    expect(isContainerCodeNode(node({ step: 'RunContainerStep', type: 'step' }))).toBe(false);
  });

  it('does not count an eval node, even one with a gate command', () => {
    // An eval gate scorer runs in the agent workspace: an authored command, not container code.
    const evalNode = node({
      scorers: [{ command: 'npm test', gate: 'tests', kind: 'gate' }],
      target: { from: 'x' },
      type: 'eval',
    });
    expect(isContainerCodeNode(evalNode)).toBe(false);
    expect(isAuthoredCommandNode(evalNode)).toBe(true);
  });
});

describe('findContainerCodeNodes / hasContainerCodeNode', () => {
  it('returns every container-code node with its id, in spec order', () => {
    const s = spec({
      a: { command: 'x', image: 'node:24-alpine', type: 'shell' },
      b: { image: 'node:24-alpine', type: 'containerStep' },
      c: { status: 'SUCCESS', type: 'terminate' },
      d: { step: 'runTests', type: 'step' },
      e: { step: 'runContainerStep', type: 'step' },
    });
    expect(findContainerCodeNodes(s).map(([id]) => id)).toEqual(['a', 'b', 'e']);
    expect(hasContainerCodeNode(s)).toBe(true);
  });

  it('is empty for a spec without container code', () => {
    const s = spec({
      a: { next: 'c', step: 'runLint', type: 'step' },
      c: { status: 'SUCCESS', type: 'terminate' },
    });
    expect(findContainerCodeNodes(s)).toEqual([]);
    expect(hasContainerCodeNode(s)).toBe(false);
  });
});

describe('isCommandGateStep', () => {
  it('is the gate steps that take a single command', () => {
    const names = listAllSteps()
      .map((s) => s.name)
      .filter(isCommandGateStep)
      .sort();
    expect(names).toEqual([
      'runBuild',
      'runLint',
      'runPerfBench',
      'runTests',
      'runTypecheck',
      'runVulnScan',
    ]);
  });
});

describe('isAuthoredCommandNode', () => {
  it('counts a gate step with a non-blank config.command', () => {
    expect(
      isAuthoredCommandNode(
        node({ config: { command: 'rm -rf /' }, step: 'runLint', type: 'step' })
      )
    ).toBe(true);
    expect(
      isAuthoredCommandNode(
        node({ config: { command: './bench' }, step: 'runPerfBench', type: 'step' })
      )
    ).toBe(true);
  });

  it('counts any inputs.command binding on a gate step', () => {
    expect(
      isAuthoredCommandNode(
        node({
          inputs: { command: { from: 'context.ticket.description' } },
          step: 'runTests',
          type: 'step',
        })
      )
    ).toBe(true);
  });

  it('ignores a gate step with no command, or a blank or non-string one', () => {
    expect(isAuthoredCommandNode(node({ step: 'runLint', type: 'step' }))).toBe(false);
    expect(
      isAuthoredCommandNode(node({ config: { command: '   ' }, step: 'runLint', type: 'step' }))
    ).toBe(false);
    expect(
      isAuthoredCommandNode(node({ config: { timeoutMs: 1000 }, step: 'runTests', type: 'step' }))
    ).toBe(false);
  });

  it('counts runQualityGates with a gate command or a bound gates list', () => {
    expect(
      isAuthoredCommandNode(
        node({
          config: { gates: [{ name: 'lint' }, { command: 'make check', name: 'tests' }] },
          step: 'runQualityGates',
          type: 'step',
        })
      )
    ).toBe(true);
    expect(
      isAuthoredCommandNode(
        node({
          inputs: { gates: { from: 'context.gates' } },
          step: 'runQualityGates',
          type: 'step',
        })
      )
    ).toBe(true);
    expect(
      isAuthoredCommandNode(
        node({
          config: { gates: [{ name: 'lint' }, { name: 'tests' }] },
          step: 'runQualityGates',
          type: 'step',
        })
      )
    ).toBe(false);
  });

  it('counts an eval node or runEvalNode step with a gate scorer command', () => {
    const scorers = [{ command: 'npm test', gate: 'tests', kind: 'gate' }];
    expect(isAuthoredCommandNode(node({ scorers, target: { from: 'x' }, type: 'eval' }))).toBe(
      true
    );
    expect(
      isAuthoredCommandNode(node({ config: { scorers }, step: 'runEvalNode', type: 'step' }))
    ).toBe(true);
    expect(
      isAuthoredCommandNode(
        node({
          scorers: [
            { gate: 'tests', kind: 'gate' },
            { expr: 'true', kind: 'assert' },
          ],
          target: { from: 'x' },
          type: 'eval',
        })
      )
    ).toBe(false);
  });

  it('ignores container code, other steps and other node types', () => {
    expect(
      isAuthoredCommandNode(node({ command: 'x', image: 'alpine:latest', type: 'shell' }))
    ).toBe(false);
    expect(
      isAuthoredCommandNode(
        node({ config: { command: 'x' }, step: 'executeImplementation', type: 'step' })
      )
    ).toBe(false);
    expect(
      isAuthoredCommandNode(node({ config: { command: 'x' }, step: 'noSuchStep', type: 'step' }))
    ).toBe(false);
    expect(isAuthoredCommandNode(node({ status: 'SUCCESS', type: 'terminate' }))).toBe(false);
  });
});

describe('findAuthoredCommandNodes / hasAuthoredCommand / hasAuthoredCode', () => {
  it('finds authored commands by id and combines them with container code', () => {
    const s = spec({
      a: { config: { command: 'make lint' }, next: 'b', step: 'runLint', type: 'step' },
      b: { next: 'c', step: 'runTests', type: 'step' },
      c: { status: 'SUCCESS', type: 'terminate' },
    });
    expect(findAuthoredCommandNodes(s).map(([id]) => id)).toEqual(['a']);
    expect(hasAuthoredCommand(s)).toBe(true);
    expect(hasContainerCodeNode(s)).toBe(false);
    expect(hasAuthoredCode(s)).toBe(true);
  });

  it('hasAuthoredCode is true for container code alone and false for neither', () => {
    expect(hasAuthoredCode(spec({ e: { step: 'runContainerStep', type: 'step' } }))).toBe(true);
    expect(hasAuthoredCode(spec({ b: { step: 'runTests', type: 'step' } }))).toBe(false);
  });
});
