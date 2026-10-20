import { describe, expect, it } from 'vitest';
import { PR_FEEDBACK_TEMPLATE_NAME } from '../../lib/prFeedback.js';
import { type Dispatcher, runSpec } from '../interpreter.js';
import type { Node } from '../spec.js';
import { validateSpec } from '../validateSpec.js';
import { ADDRESS_PR_FEEDBACK_SPEC } from './addressPrFeedback.js';
import { BUILTIN_TEMPLATES } from './index.js';

type StepNode = Extract<Node, { type: 'step' }>;

describe('address-pr-feedback', () => {
  it('is the template a pull-request feedback trigger starts by name', () => {
    expect(ADDRESS_PR_FEEDBACK_SPEC.name).toBe(PR_FEEDBACK_TEMPLATE_NAME);
    expect(BUILTIN_TEMPLATES.some((t) => t.name === PR_FEEDBACK_TEMPLATE_NAME)).toBe(true);
  });

  it('validates', () => {
    expect(validateSpec(ADDRESS_PR_FEEDBACK_SPEC).errors).toEqual([]);
  });

  it('refuses workflow-file changes on every implementer step', () => {
    const implementerSteps = new Set([
      'executePrFeedbackImplementation',
      'executeCIFixImplementation',
    ]);
    const steps = Object.values(ADDRESS_PR_FEEDBACK_SPEC.nodes).filter(
      (n): n is StepNode => n.type === 'step' && implementerSteps.has(n.step)
    );
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (const node of steps) {
      expect(node.config).toMatchObject({ refuseWorkflowChanges: true });
    }
  });

  it('keeps the work branch for the CI watch, then finishes it', () => {
    const pushes = Object.values(ADDRESS_PR_FEEDBACK_SPEC.nodes).filter(
      (n): n is StepNode => n.type === 'step' && n.step === 'pushPrFeedbackToPullRequest'
    );
    expect(pushes.length).toBe(2);
    for (const node of pushes) {
      expect(node.config).toMatchObject({ keepWorkBranch: true });
    }
  });

  it('reaches every node from the gather step, and every node reaches a terminate', () => {
    const reachable = new Set<string>([ADDRESS_PR_FEEDBACK_SPEC.entry]);
    const queue = [ADDRESS_PR_FEEDBACK_SPEC.entry];
    while (queue.length > 0) {
      const id = queue.pop() as string;
      const node = ADDRESS_PR_FEEDBACK_SPEC.nodes[id];
      for (const next of ['next', 'onTrue', 'onFalse']) {
        const target = (node as Record<string, unknown>)[next];
        if (typeof target === 'string' && !reachable.has(target)) {
          reachable.add(target);
          queue.push(target);
        }
      }
    }
    expect(reachable.size).toBe(Object.keys(ADDRESS_PR_FEEDBACK_SPEC.nodes).length);

    const memo = new Map<string, boolean>();
    const ends = (id: string, seen: Set<string>): boolean => {
      if (memo.has(id)) {
        return memo.get(id) === true;
      }
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      const node = ADDRESS_PR_FEEDBACK_SPEC.nodes[id];
      const ok =
        node.type === 'terminate' ||
        ['next', 'onTrue', 'onFalse']
          .map((k) => (node as Record<string, unknown>)[k])
          .filter((t): t is string => typeof t === 'string')
          .some((t) => ends(t, seen));
      memo.set(id, ok);
      return ok;
    };
    for (const id of Object.keys(ADDRESS_PR_FEEDBACK_SPEC.nodes)) {
      expect(ends(id, new Set()), id).toBe(true);
    }
  });

  it('runs the skip path end to end without the fixer or the push', async () => {
    const dispatched: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatchStep({ step }) {
        dispatched.push(step);
        if (step === 'gatherPrFeedback') {
          return { decision: 'skip', reason: 'the pull request is not open' };
        }
        return {};
      },
      async recordStep() {},
      async waitSignal() {
        return { passed: true };
      },
    };
    const result = await runSpec(
      ADDRESS_PR_FEEDBACK_SPEC,
      {
        context: {},
        nodes: {},
        request: { externalTicketId: 'prfb-9-777', payload: {}, repoId: 'r' },
        workflow: { id: 'w' },
      } as never,
      dispatcher
    );
    expect(result.status).toBe('SKIPPED');
    expect(dispatched).toEqual(['gatherPrFeedback', 'respondToPrFeedback']);
  });
});

const GATHER_FIX = {
  decision: 'fix',
  fixer: 'reviewFixer',
  headSha: 'a'.repeat(40),
  origin: 'workflow',
  workBranch: 'auto/prfb-9-777',
} as const;
const CODE_RESULT = {
  branch: 'auto/prfb-9-777',
  filesChanged: [{ path: 'src/a.ts' }],
  headSha: 'c'.repeat(40),
};

async function walk(
  overrides: Record<string, unknown | (() => unknown)> = {},
  request: Record<string, unknown> = {}
) {
  const dispatched: { output: unknown; step: string }[] = [];
  const dispatcher: Dispatcher = {
    async dispatchStep({ inputs, step }) {
      const value = overrides[step];
      const out =
        typeof value === 'function'
          ? (value as (i: unknown) => unknown)(inputs)
          : value !== undefined
            ? value
            : step === 'gatherPrFeedback'
              ? GATHER_FIX
              : {};
      dispatched.push({ output: out, step });
      return out;
    },
    async recordStep() {},
    async waitSignal() {
      return { passed: true };
    },
  };
  const result = await runSpec(
    ADDRESS_PR_FEEDBACK_SPEC,
    {
      context: {},
      nodes: {},
      request: {
        externalTicketId: 'prfb-9-777',
        payload: { maxCiFixAttempts: 0, ...request },
        repoId: 'r',
      },
      workflow: { id: 'w' },
    } as never,
    dispatcher
  );
  return { dispatched, result };
}

describe('address-pr-feedback — paths after gather', () => {
  it('every terminal path after the work branch exists goes through finishPrFeedbackPush', async () => {
    for (const [name, overrides] of [
      ['push refused', { pushPrFeedbackToPullRequest: { pushed: false, reason: 'x' } }],
      ['push threw', { pushPrFeedbackToPullRequest: null }],
      ['fix failed', { executePrFeedbackImplementation: null }],
      ['no change', { executePrFeedbackImplementation: { ...CODE_RESULT, filesChanged: [] } }],
      ['pushed, CI passed', {}],
      ['pushed, CI unreadable', { waitForCiByPolling: null }],
    ] as const) {
      const { dispatched } = await walk(overrides);
      expect(
        dispatched.some((d) => d.step === 'finishPrFeedbackPush'),
        `${name} must finish the work branch`
      ).toBe(true);
    }
  });

  it('an unreadable CI watch reports unknown and ends SUCCESS', async () => {
    const { dispatched, result } = await walk({
      pushPrFeedbackToPullRequest: { commitSha: 'c'.repeat(40), pushed: true },
      respondToPrFeedback: { commented: true, verdict: { summary: 's', threads: [] } },
      waitForCiByPolling: null,
    });
    expect(result.status).toBe('SUCCESS');
    const responds = dispatched.filter((d) => d.step === 'respondToPrFeedback');
    expect(responds.length).toBe(2);
  });

  it('a thrown push replies a fixed reason and cleans up', async () => {
    const seen: { skipReason?: unknown }[] = [];
    const { dispatched, result } = await walk({
      pushPrFeedbackToPullRequest: null,
      respondToPrFeedback: (i: { skipReason?: string }) => {
        seen.push({ skipReason: i.skipReason });
        return { commented: true };
      },
    });
    expect(result.status).toBe('FAILED');
    expect(seen[0]?.skipReason).toBe('the push could not be completed');
    expect(dispatched.some((d) => d.step === 'finishPrFeedbackPush')).toBe(true);
  });

  it('routes to the agent fixer only when gather says agent', async () => {
    const agent = await walk({
      gatherPrFeedback: { ...GATHER_FIX, fixer: 'agent' },
      runAgentPrFeedbackTask: { codeResult: CODE_RESULT, text: 'done' },
      pushPrFeedbackToPullRequest: { commitSha: 'c'.repeat(40), pushed: true },
      waitForCiByPolling: { ciPassed: true },
    });
    expect(agent.dispatched.some((d) => d.step === 'runAgentPrFeedbackTask')).toBe(true);
    expect(agent.dispatched.some((d) => d.step === 'executePrFeedbackImplementation')).toBe(false);
    const fallback = await walk({
      gatherPrFeedback: { ...GATHER_FIX, fixer: 'reviewFixer', origin: 'agent_run' },
      executePrFeedbackImplementation: CODE_RESULT,
      pushPrFeedbackToPullRequest: { commitSha: 'c'.repeat(40), pushed: true },
      waitForCiByPolling: { ciPassed: true },
    });
    expect(fallback.dispatched.some((d) => d.step === 'executePrFeedbackImplementation')).toBe(
      true
    );
    expect(fallback.dispatched.some((d) => d.step === 'runAgentPrFeedbackTask')).toBe(false);
  });
});
