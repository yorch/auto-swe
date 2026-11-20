import { describe, expect, it } from 'vitest';
import type { Context } from '../expr.js';
import { type Dispatcher, runSpec } from '../interpreter.js';
import { type Node, parseWorkflowSpec, type WorkflowSpec } from '../spec.js';
import { BUILTIN_TEMPLATES } from './index.js';

/**
 * `four-eyes` and `consensus-review` give a pushed fix a fresh CI attempt budget with
 * `resetVisits: ['fetchLogs']` on the node that keeps the fix. They used to do it with a `set`
 * value `nodes.fetchLogs.visits: { literal: 0 }` on the same node. This walks both forms over the
 * same seeded scenarios and holds them to the same run: the same terminal status and result, the
 * same activity calls in the same order, the same `fetchLogs` count at every CI-log fetch, and the
 * same final context.
 *
 * The earlier form is rebuilt from today's spec by moving the reset back into the `set`; the
 * reviewed snapshots under `__golden__/sugar/` show that this is the only difference between the
 * two releases of these templates.
 */

const RESETTING: Record<string, string> = {
  'consensus-review': 'updateCodeAfterFix',
  'four-eyes': 'updateCodeAfterSignoffFix',
};

function template(name: string): WorkflowSpec {
  const t = BUILTIN_TEMPLATES.find((x) => x.name === name);
  if (!t) {
    throw new Error(`no built-in template ${name}`);
  }
  return parseWorkflowSpec(t.spec);
}

/** The spec as it was: the reset is a `set` value again and the node has no `resetVisits`. */
function asSetReset(spec: WorkflowSpec, nodeId: string): WorkflowSpec {
  const node = spec.nodes[nodeId];
  if (node?.type !== 'set' || node.resetVisits === undefined) {
    throw new Error(`${nodeId} is not a resetting set node`);
  }
  const { resetVisits, ...rest } = node;
  const values = { ...rest.values };
  for (const id of resetVisits) {
    values[`nodes.${id}.visits`] = { literal: 0 };
  }
  return { ...spec, nodes: { ...spec.nodes, [nodeId]: { ...rest, values } as Node } };
}

/** mulberry32: a small seeded PRNG, so every scenario is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Trace {
  status: string;
  result: unknown;
  calls: string[];
  /** `nodes.fetchLogs.visits` each time the CI logs are fetched. */
  ciEntries: unknown[];
  /** `nodes.fetchLogs.visits` as the run reaches each CI wait. */
  ciWaits: unknown[];
  finalContext: string;
  error?: string;
}

const SHAS = ['sha-a', 'sha-b', 'sha-c'];

/**
 * A dispatcher whose every answer comes from the seed, in call order. Two specs that walk the
 * same path draw the same answers; a divergence shows up as a different call sequence.
 */
function scenario(seed: number): {
  d: Dispatcher;
  trace: Pick<Trace, 'calls' | 'ciEntries' | 'ciWaits'>;
} {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const trace = { calls: [] as string[], ciEntries: [] as unknown[], ciWaits: [] as unknown[] };
  let lastCtx: Context | undefined;
  const visits = (ctx: Context | undefined) =>
    (ctx?.nodes as Record<string, { visits?: unknown }> | undefined)?.fetchLogs?.visits;
  const d: Dispatcher = {
    async dispatchStep({ step, nodeId, ctx }) {
      lastCtx = ctx;
      trace.calls.push(`${nodeId}:${step}`);
      if (step === 'fetchCILogs') {
        trace.ciEntries.push(visits(ctx));
      }
      if (r() < 0.04) {
        throw new Error(`${step} failed`);
      }
      switch (step) {
        case 'validateContext':
          return { successCriteria: ['works'] };
        case 'executeImplementation':
        case 'executeCIFixImplementation':
        case 'executeReviewFixImplementation':
          return { headSha: pick(SHAS) };
        case 'runReviewNetwork': {
          const approved = r() < 0.5;
          return {
            approved,
            rejectionFingerprint: approved ? '' : pick(['f1', 'f2']),
            rejectionSummary: approved ? '' : 'fix it',
            stalled: !approved && r() < 0.15,
          };
        }
        case 'createOrUpdatePullRequest':
          return { prNumber: 7, prUrl: 'https://example.test/pr/7' };
        case 'fetchCILogs':
          return { logs: `log-${Math.floor(r() * 3)}` };
        default:
          return {};
      }
    },
    async recordStep() {},
    async waitSignal(name) {
      trace.calls.push(`wait:${name}`);
      if (name === 'ciPipelineSignal') {
        trace.ciWaits.push(visits(lastCtx));
        if (r() < 0.03) {
          return undefined;
        }
        return { logsUrl: 'https://ci.test/log', passed: r() < 0.45 };
      }
      if (r() < 0.03) {
        return undefined;
      }
      const roll = r();
      return {
        action: roll < 0.55 ? 'approve' : roll < 0.9 ? 'request_changes' : 'reject',
        comment: 'please change',
      };
    },
  };
  return { d, trace };
}

async function walk(spec: WorkflowSpec, seed: number): Promise<Trace> {
  const { d, trace } = scenario(seed);
  const ctx: Context = { context: {}, nodes: {}, request: {}, workflow: { id: 'w' } };
  try {
    const out = await runSpec(spec, ctx, d);
    return {
      ...trace,
      finalContext: JSON.stringify(out.finalContext),
      result: out.result,
      status: out.status,
    };
  } catch (err) {
    return {
      ...trace,
      error: String(err),
      finalContext: JSON.stringify(ctx),
      result: null,
      status: 'THREW',
    };
  }
}

const SEEDS = 400;

describe.each(Object.entries(RESETTING))(
  '%s: resetVisits behaves as the set it replaced',
  (name, nodeId) => {
    const current = template(name);
    const earlier = asSetReset(current, nodeId);

    it('differs from the earlier form only on the resetting node', () => {
      const changed = Object.keys(current.nodes).filter(
        (id) => JSON.stringify(current.nodes[id]) !== JSON.stringify(earlier.nodes[id])
      );
      expect(changed).toEqual([nodeId]);
      expect(current.nodes[nodeId]).toMatchObject({ resetVisits: ['fetchLogs'] });
    });

    it(`walks ${SEEDS} seeded scenarios identically, CI budget included`, async () => {
      let resetsAfterAFix = 0;
      let fixesAfterAReset = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const [a, b] = await Promise.all([walk(current, seed), walk(earlier, seed)]);
        expect(a, `seed ${seed}`).toStrictEqual(b);
        // A wait that sees the count back at 0 after it had been raised is a reset that mattered.
        const waits = a.ciWaits;
        if (waits.some((v, i) => v === 0 && waits.slice(0, i).some((w) => Number(w) > 0))) {
          resetsAfterAFix++;
          // The count is read as the fetch runs, after its own entry is counted: a fetch whose
          // count is not above the one before it came after a reset.
          if (a.ciEntries.some((v, i) => i > 0 && Number(v) <= Number(a.ciEntries[i - 1]))) {
            fixesAfterAReset++;
          }
        }
      }
      // The corpus has to reach the path it is about: a reset after a CI fix, and a CI fix after it.
      expect(resetsAfterAFix).toBeGreaterThan(5);
      expect(fixesAfterAReset).toBeGreaterThan(2);
    });
  }
);
