import { describe, expect, it } from 'vitest';
import { evalBoolean } from '../expr.js';
import { type Dispatcher, runSpec } from '../interpreter.js';
import { type Node, nodeEdges } from '../spec.js';
import { BUILTIN_TEMPLATES } from './index.js';
import {
  MODEL_CATALOG_REFRESH_CRITERIA,
  MODEL_CATALOG_REFRESH_PROMPT,
  MODEL_CATALOG_REFRESH_SPEC as spec,
} from './modelCatalogRefresh.js';

const nodes = Object.entries(spec.nodes);
const stepsOf = (name: string) => nodes.filter(([, n]) => n.type === 'step' && n.step === name);

/** Node ids reachable from `from`, following every edge. */
function reachable(from: string): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const id = queue.pop() as string;
    if (seen.has(id) || !spec.nodes[id]) {
      continue;
    }
    seen.add(id);
    queue.push(...nodeEdges(spec.nodes[id] as Node).map(([, target]) => target));
  }
  return seen;
}

describe('model-catalog-refresh template', () => {
  it('is registered as a built-in with its own description', () => {
    const t = BUILTIN_TEMPLATES.find((b) => b.name === 'model-catalog-refresh');
    expect(t?.spec).toBe(spec);
    expect(t?.description).toBe(spec.description);
  });

  it('lists the model ids before the implementer, which is the only step that makes a workspace', () => {
    expect(stepsOf('listProviderModels')).toHaveLength(1);
    const [implementId] = stepsOf('executeImplementation')[0] ?? [];
    expect(implementId).toBe('implement');
    // The precondition runs ahead of any workspace: listModels reaches `implement`, never the reverse.
    expect(reachable('listModels').has('implement')).toBe(true);
    expect(reachable('implement').has('listModels')).toBe(false);
    expect(spec.entry).toBe('setCriteria');
    expect(spec.nodes.setCriteria).toMatchObject({ next: 'listModels' });
  });

  it('binds the listing into the implementer as guidance, and carries the instructions in its prompt', () => {
    expect(spec.nodes.implement).toMatchObject({
      config: { systemPrompt: MODEL_CATALOG_REFRESH_PROMPT },
      inputs: { guidance: { from: 'nodes.listModels.output.guidance' } },
    });
    expect(MODEL_CATALOG_REFRESH_PROMPT).toMatch(/no curl/);
    expect(MODEL_CATALOG_REFRESH_PROMPT).toMatch(/node -e "fetch/);
    expect(MODEL_CATALOG_REFRESH_PROMPT).toMatch(/UNVERIFIED/);
    expect(MODEL_CATALOG_REFRESH_PROMPT).toMatch(/only for providers already present/i);
  });

  it('puts the citation rule in the success criteria', () => {
    expect(spec.nodes.setCriteria).toMatchObject({
      values: { 'context.successCriteria': { literal: MODEL_CATALOG_REFRESH_CRITERIA } },
    });
    expect(MODEL_CATALOG_REFRESH_CRITERIA[0]).toBe(
      'Every changed price cites an official URL; no invented figures.'
    );
  });

  it('gates on the builtinModels test', () => {
    const [[, gate]] = stepsOf('runTests') as [[string, Node & { config?: { command?: string } }]];
    expect(gate.config?.command).toContain('packages/shared/src/lib/builtinModels.test.ts');
  });

  it('ends at a draft pull request: no CI loop, no approval inside the run', () => {
    expect(spec.nodes.openPR).toMatchObject({
      config: { draft: true },
      step: 'createOrUpdatePullRequest',
    });
    expect(stepsOf('createOrUpdatePullRequest')).toHaveLength(1);
    for (const [id, n] of nodes) {
      expect(n.type.startsWith('human'), id).toBe(false);
      expect(n.type === 'signal', id).toBe(false);
      if (n.type === 'step') {
        expect(
          [
            'fetchCILogs',
            'resolveCiWaitConfig',
            'waitForCiByPolling',
            'executeCIFixImplementation',
          ],
          id
        ).not.toContain(n.step);
      }
    }
    expect(spec.nodes.savePrInfo).toMatchObject({ next: 'done' });
  });

  describe('no change, no pull request', () => {
    const cond = spec.nodes.checkChanges as { expr: string; onTrue: string; onFalse: string };
    const ctx = (filesChanged: unknown[]) => ({
      nodes: { implement: { output: { filesChanged } } },
    });

    it('the expression language can say "no files changed" with a path lookup on length', () => {
      expect(evalBoolean(cond.expr, ctx([]))).toBe(true);
      expect(evalBoolean(cond.expr, ctx([{ path: 'a.ts' }]))).toBe(false);
    });

    it('an empty diff terminates SUCCESS without ever reaching the pull request', () => {
      expect(cond.onTrue).toBe('doneNoChange');
      expect(spec.nodes.doneNoChange).toMatchObject({ status: 'SUCCESS', type: 'terminate' });
      expect(reachable('doneNoChange').has('openPR')).toBe(false);
    });

    function dispatcher(filesChanged: unknown[]) {
      const steps: Array<{ step: string; config: Record<string, unknown> }> = [];
      const d: Dispatcher = {
        async dispatchStep({ step, config }) {
          steps.push({ config, step });
          const out: Record<string, unknown> = {
            createOrUpdatePullRequest: { prNumber: 9, prUrl: 'https://example.test/pull/9' },
            executeImplementation: { filesChanged },
            listProviderModels: { guidance: '## Live model ids' },
            runReviewNetwork: { approved: true },
            runTests: { passed: true },
            updateDomainState: {},
          };
          return out[step];
        },
        async recordStep() {},
        async waitSignal() {
          return undefined;
        },
      };
      return { d, steps };
    }
    const base = () => ({
      context: {},
      nodes: {},
      request: { externalTicketId: 'T', repoId: 'r' },
      workflow: { id: 'w' },
    });

    it('runs to a draft PR when the implementer changed files', async () => {
      const { d, steps } = dispatcher([{ path: 'packages/shared/src/lib/builtinModels.ts' }]);
      const result = await runSpec(spec, base(), d);
      expect(result.status).toBe('SUCCESS');
      expect(steps.map((s) => s.step)).toEqual([
        'listProviderModels',
        'updateDomainState',
        'executeImplementation',
        'runTests',
        'updateDomainState',
        'runReviewNetwork',
        'createOrUpdatePullRequest',
      ]);
      expect(steps.at(-1)?.config).toEqual({ draft: true });
    });

    it('ends SUCCESS with no review, tests or pull request when nothing changed', async () => {
      const { d, steps } = dispatcher([]);
      const result = await runSpec(spec, base(), d);
      expect(result.status).toBe('SUCCESS');
      expect(steps.map((s) => s.step)).toEqual([
        'listProviderModels',
        'updateDomainState',
        'executeImplementation',
      ]);
    });
  });
});
