import {
  collectUseProblems,
  parseWorkflowSpec,
  type WorkflowSpec,
} from '@auto-swe/shared/workflow';
import { describe, expect, it } from 'vitest';
import { macroFriendlyName, macroUseDisplayName } from './macroDisplay';
import {
  detachUseInSpec,
  macroUseInfo,
  parseUseArgsDraft,
  reexpandUseWithArgs,
} from './macroEdits';
import { CI_USE, macroSpec } from './macroTestSpec';
import { deleteNodeFromSpec, macroLockReason, renameNodeInSpec } from './specEdits';

/** The spec still parses and its uses agree with its nodes: what a save checks. */
function expectSaveable(spec: WorkflowSpec) {
  expect(() => parseWorkflowSpec(spec)).not.toThrow();
  expect(collectUseProblems(spec)).toEqual([]);
}

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as Extract<T, { ok: true }>;
}

describe('macro display names', () => {
  it('names a use by its macro and id', () => {
    expect(macroUseDisplayName(macroSpec(), 'ci')).toBe('CI loop · ci');
    expect(macroUseDisplayName(macroSpec(), 'pr')).toBe('Open pull request · pr');
  });

  it('falls back to the raw macro name, or "Macro" for an undeclared use', () => {
    expect(macroFriendlyName('somethingNew@3')).toBe('somethingNew');
    expect(macroUseDisplayName(macroSpec(), 'nope')).toBe('Macro · nope');
  });
});

describe('macroUseInfo', () => {
  it('describes a clean use', () => {
    const info = macroUseInfo(macroSpec(), 'ci');
    expect(info).toMatchObject({
      args: CI_USE.args,
      drifted: false,
      knownMacro: true,
      macroRef: 'ciLoop@1',
      problems: [],
    });
    expect(info.memberIds).toEqual([
      'terminateCITimedOut',
      'waitForCI',
      'checkCI',
      'terminateCIFailed',
    ]);
  });

  it('reports drift after a hand edit to one of its nodes', () => {
    const base = macroSpec();
    const edited: WorkflowSpec = {
      ...base,
      nodes: { ...base.nodes, waitForCI: { ...base.nodes.waitForCI, timeout: '9h' } as never },
    };
    const info = macroUseInfo(edited, 'ci');
    expect(info.drifted).toBe(true);
    expect(info.problems).toHaveLength(1);
    expect(info.problems[0]).toMatchObject({ code: 'USE_DRIFT', nodeId: 'waitForCI', useId: 'ci' });
    // Only this use's problems.
    expect(macroUseInfo(edited, 'pr').problems).toEqual([]);
  });

  it('reports a tag that no uses entry declares', () => {
    const base = macroSpec();
    const spec: WorkflowSpec = {
      ...base,
      nodes: { ...base.nodes, done: { ...base.nodes.done, use: 'ghost' } as never },
    };
    const info = macroUseInfo(spec, 'ghost');
    expect(info.macroRef).toBeUndefined();
    expect(info.knownMacro).toBe(false);
    expect(info.problems.map((p) => p.code)).toEqual(['USE_NOT_DECLARED']);
  });
});

describe('parseUseArgsDraft', () => {
  it('accepts arguments the schema accepts, as written', () => {
    expect(parseUseArgsDraft('ciLoop@1', '{"fix": false, "passed": "done"}')).toEqual({
      args: { fix: false, passed: 'done' },
      ok: true,
    });
  });

  it('says when the text is not JSON or not an object', () => {
    const bad = parseUseArgsDraft('ciLoop@1', '{fix:');
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/^Not valid JSON/);
    expect(parseUseArgsDraft('ciLoop@1', '[1]')).toEqual({
      error: 'Arguments must be a JSON object',
      ok: false,
    });
  });

  it("shows the schema's own message, path first", () => {
    const wrongType = parseUseArgsDraft('ciLoop@1', '{"fix": false, "passed": 5}');
    expect(!wrongType.ok && wrongType.error).toMatch(/^passed: /);
    const extraKey = parseUseArgsDraft('ciLoop@1', '{"fix": false, "passed": "done", "x": 1}');
    expect(extraKey.ok).toBe(false);
    expect(!extraKey.ok && extraKey.error).toMatch(/x/);
    expect(parseUseArgsDraft('nope@1', '{}')).toEqual({
      error: "Unknown macro 'nope@1'",
      ok: false,
    });
  });
});

describe('reexpandUseWithArgs', () => {
  it('repairs drift by regenerating the nodes', () => {
    const base = macroSpec();
    const edited: WorkflowSpec = {
      ...base,
      nodes: { ...base.nodes, waitForCI: { ...base.nodes.waitForCI, timeout: '9h' } as never },
    };
    const { spec } = ok(reexpandUseWithArgs(edited, 'ci'));
    expectSaveable(spec);
    expect((spec.nodes.waitForCI as { timeout: string }).timeout).toBe('4h');
  });

  it('applies edited arguments and moves edges into the use onto its new entry', () => {
    const args = { fix: false, passed: 'done', wait: 'pollOrSignal' };
    const { spec } = ok(reexpandUseWithArgs(macroSpec(), 'ci', args));
    expect(spec.uses?.ci).toEqual({ args, macro: 'ciLoop@1' });
    expect(spec.nodes.loadCiWaitConfig).toBeDefined();
    // `pr` routed into `waitForCI`, the old entry; it now enters at the poll router, and
    // its own arguments say so, so neither use drifts.
    expect((spec.nodes.savePrInfo as { next?: string }).next).toBe('loadCiWaitConfig');
    expect(spec.uses?.pr?.args).toEqual({ next: 'loadCiWaitConfig' });
    // The expansion's own edge to `waitForCI` is the macro's, and stays.
    expect((spec.nodes.routeCiWait as { onFalse?: string }).onFalse).toBe('waitForCI');
    expectSaveable(spec);
  });

  it('follows the entry back when it moves the other way, dropping the vanished nodes', () => {
    const poll = { args: { fix: false, passed: 'done', wait: 'pollOrSignal' }, macro: 'ciLoop@1' };
    const there = ok(reexpandUseWithArgs(macroSpec(), 'ci', poll.args)).spec;
    const { spec } = ok(reexpandUseWithArgs(there, 'ci', { fix: false, passed: 'done' }));
    expect(spec.nodes.loadCiWaitConfig).toBeUndefined();
    expect((spec.nodes.savePrInfo as { next?: string }).next).toBe('waitForCI');
    expectSaveable(spec);
  });

  it('refuses an expansion that would replace a hand-written node, naming it', () => {
    const base = macroSpec();
    const spec: WorkflowSpec = {
      ...base,
      nodes: { ...base.nodes, loadCiWaitConfig: { status: 'SKIPPED', type: 'terminate' } },
    };
    const r = reexpandUseWithArgs(spec, 'ci', { fix: false, passed: 'done', wait: 'pollOrSignal' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/loadCiWaitConfig/);
  });

  it('refuses a use the spec does not declare', () => {
    expect(reexpandUseWithArgs(macroSpec(), 'ghost').ok).toBe(false);
  });
});

describe('detachUseInSpec', () => {
  it('keeps the nodes, untagged, and drops the uses entry', () => {
    const { spec } = ok(detachUseInSpec(macroSpec(), 'ci'));
    expect(spec.uses).toEqual({ pr: macroSpec().uses?.pr });
    expect(spec.nodes.waitForCI).toBeDefined();
    expect(spec.nodes.waitForCI?.use).toBeUndefined();
    expect(spec.nodes.openPR?.use).toBe('pr');
    expectSaveable(spec);
  });

  it('turns a drifted use into ordinary nodes that keep the hand edit', () => {
    const base = macroSpec();
    const edited: WorkflowSpec = {
      ...base,
      nodes: { ...base.nodes, waitForCI: { ...base.nodes.waitForCI, timeout: '9h' } as never },
    };
    const { spec } = ok(detachUseInSpec(edited, 'ci'));
    expect((spec.nodes.waitForCI as { timeout: string }).timeout).toBe('9h');
    expectSaveable(spec);
  });

  it('strips a tag that no uses entry declares', () => {
    const base = macroSpec();
    const spec: WorkflowSpec = {
      ...base,
      nodes: { ...base.nodes, done: { ...base.nodes.done, use: 'ghost' } as never },
    };
    const detached = ok(detachUseInSpec(spec, 'ghost')).spec;
    expect(detached.nodes.done?.use).toBeUndefined();
    expectSaveable(detached);
    expect(detachUseInSpec(macroSpec(), 'ghost').ok).toBe(false);
  });
});

describe('deleting and renaming the nodes of a macro use', () => {
  it('refuses both for a node of a declared use, and says why', () => {
    const spec = macroSpec();
    expect(macroLockReason(spec, 'checkCI')).toMatch(/CI loop · ci/);
    expect(deleteNodeFromSpec(spec, 'checkCI')).toBe(spec);
    expect(renameNodeInSpec(spec, 'checkCI', 'checkCi2')).toBe(spec);
  });

  it('allows both once the use is detached', () => {
    const detached = ok(detachUseInSpec(macroSpec(), 'ci')).spec;
    expect(macroLockReason(detached, 'checkCI')).toBeNull();
    expect(
      deleteNodeFromSpec(detached, 'terminateCIFailed').nodes.terminateCIFailed
    ).toBeUndefined();
    expect(renameNodeInSpec(detached, 'checkCI', 'gate').nodes.gate).toBeDefined();
  });

  it('does not lock a node outside every use, or one whose tag names no use', () => {
    const base = macroSpec();
    expect(macroLockReason(base, 'start')).toBeNull();
    const stray: WorkflowSpec = {
      ...base,
      nodes: { ...base.nodes, done: { ...base.nodes.done, use: 'ghost' } as never },
    };
    expect(macroLockReason(stray, 'done', 'rename')).toBeNull();
  });

  it('refuses to delete a node a use routes to, and says which use', () => {
    const spec = macroSpec();
    expect(macroLockReason(spec, 'done')).toMatch(
      /routed to by use .*CI loop · ci.*change its arguments first/
    );
    expect(deleteNodeFromSpec(spec, 'done')).toBe(spec);
    expect(macroLockReason(spec, 'done', 'rename')).toBeNull();
  });

  it('follows nested edge arguments such as fix.handoff.rereview', () => {
    const base = macroSpec();
    const withoutPassed: WorkflowSpec = {
      ...base,
      uses: {
        ci: {
          args: { fix: { handoff: { rereview: 'done' } }, passed: 'start' },
          macro: 'ciLoop@1',
        },
      },
    };
    expect(macroLockReason(withoutPassed, 'done')).toMatch(/routed to by use/);
    expect(deleteNodeFromSpec(withoutPassed, 'done')).toBe(withoutPassed);
  });

  it('renaming a node a use routes to rewrites the use arguments too, so nothing drifts', () => {
    const spec = renameNodeInSpec(macroSpec(), 'done', 'finished');
    expect(spec.uses?.ci?.args).toEqual({ fix: false, passed: 'finished' });
    expect((spec.nodes.checkCI as { onTrue?: string }).onTrue).toBe('finished');
    expectSaveable(spec);
  });
});
