/**
 * The canonical-core layer of the skeleton policy, driven through `checkSkeletonPolicy` (the full
 * policy) on plans built from the shipped core. Each hostile case is a repro from an adversarial
 * round; every one must be REFUSED with the codes named, and the positive controls beside them
 * must pass so a policy that refuses everything cannot satisfy this file.
 */

import { describe, expect, it } from 'vitest';
import { TICKET_TO_MERGE_SPEC } from '../templates/ticketToMerge.js';
import { canonicalCoreIds } from './canonicalCore.js';
import {
  canonicalDeliveringRaw,
  clone,
  outputOnlyRaw,
  parse,
  type RawSpec,
} from './skeletonFixtures.js';
import { applySkeletonPolicy, checkSkeletonPolicy, type SkeletonMode } from './skeletonPolicy.js';

type Edit = (raw: RawSpec) => void;

function codesOf(raw: RawSpec, mode: SkeletonMode = 'delivering'): string[] {
  return checkSkeletonPolicy(parse(clone(raw)), mode).errors.map((e) => e.code);
}

function plan(edit: Edit): RawSpec {
  const raw = canonicalDeliveringRaw();
  edit(raw);
  return raw;
}

describe('positive controls', () => {
  it('passes a pre-region feeding the canonical core', () => {
    const report = checkSkeletonPolicy(parse(canonicalDeliveringRaw()), 'delivering');
    expect(report.errors).toEqual([]);
    expect(report.regions?.pre.sort()).toEqual(
      [
        'checkActionable',
        'gatherTicket',
        'research',
        'setSuccessCriteria',
        'setTicket',
        'terminateNotActionable',
        'validate',
      ].sort()
    );
    expect(report.regions?.post).toEqual([]);
    expect(report.regions?.core).toEqual(canonicalCoreIds());
  });

  it('passes the shipped ticket-to-merge template, with its validate phase as the pre-region', () => {
    const report = checkSkeletonPolicy(TICKET_TO_MERGE_SPEC, 'delivering');
    expect(report.errors).toEqual([]);
    expect(report.regions?.pre.sort()).toEqual(
      [
        'checkActionable',
        'gatherTicket',
        'setSuccessCriteria',
        'setTicket',
        'terminateNotActionable',
        'validate',
      ].sort()
    );
  });

  it('passes the core behind validation alone, with the guidance slot absent', () => {
    const raw = canonicalDeliveringRaw();
    delete raw.nodes.research;
    raw.entry = 'gatherTicket';
    raw.nodes.implement = {
      ...raw.nodes.implement,
      inputs: {
        successCriteria: { default: [], from: 'context.successCriteria' },
        ticket: { from: 'context.ticket' },
      },
    };
    expect(codesOf(raw)).toEqual([]);
  });

  it('passes a post-merge region hung off the merge wait and returning to commitLesson', () => {
    const raw = plan((r) => {
      r.nodes.waitForHumanMerge = { ...r.nodes.waitForHumanMerge, onReceive: 'announce' };
      r.nodes.announce = {
        agentRef: 'contentWriter',
        inputs: { goal: { from: 'request.description' } },
        next: 'commitLesson',
        storeAs: 'context.scratch.announcement',
        type: 'agent',
      };
    });
    const report = checkSkeletonPolicy(parse(raw), 'delivering');
    expect(report.errors).toEqual([]);
    expect(report.regions?.post).toEqual(['announce']);
  });

  it('passes a pre-region that gathers, validates and branches before the core', () => {
    const raw = plan((r) => {
      r.nodes.research = {
        agentRef: 'productAnalyst',
        inputs: { goal: { from: 'request.description' } },
        next: 'route',
        storeAs: 'context.planNotes',
        type: 'agent',
      };
      r.nodes.route = {
        expr: 'context.scratch.skip == true',
        onFalse: 'gatherTicket',
        onTrue: 'stop',
        type: 'cond',
      };
      r.nodes.stop = { status: 'FAILED', type: 'terminate' };
    });
    expect(codesOf(raw)).toEqual([]);
  });
});

describe('the core is not editable', () => {
  const coreIds = canonicalCoreIds();

  it.each(coreIds)('refuses an edit to core node %s', (id) => {
    const raw = canonicalDeliveringRaw();
    raw.nodes[id] = { ...raw.nodes[id], title: 'Looks the same' };
    const report = checkSkeletonPolicy(parse(raw), 'delivering');
    expect(report.errors.some((e) => e.code === 'CORE_MISMATCH' && e.nodeId === id)).toBe(true);
  });

  it.each(coreIds.filter((id) => id !== 'implement'))(
    'refuses a visit bound added to core node %s',
    (id) => {
      const raw = canonicalDeliveringRaw();
      raw.nodes[id] = { ...raw.nodes[id], maxVisits: 99 };
      expect(codesOf(raw)).toContain('CORE_MISMATCH');
    }
  );

  it('refuses a core with a node missing', () => {
    const raw = canonicalDeliveringRaw();
    delete raw.nodes.uiVerify;
    raw.nodes.implement = { ...raw.nodes.implement, next: 'clearCiResult' };
    expect(codesOf(raw)).toContain('CORE_MISMATCH');
  });

  it('keeps the structural checks running over core nodes too', () => {
    const raw = canonicalDeliveringRaw();
    raw.nodes.review = { ...raw.nodes.review, onFail: 'warn' };
    const codes = codesOf(raw);
    expect(codes).toContain('ONFAIL_WARN');
    expect(codes).toContain('CORE_MISMATCH');
  });

  it('refuses a verdict written as == false', () => {
    const raw = plan((r) => {
      r.nodes.checkApproval = {
        ...r.nodes.checkApproval,
        expr: 'nodes.review.output.approved == false',
        onFalse: 'forgetRejection',
        onTrue: 'storeRejection',
      };
    });
    const codes = codesOf(raw);
    expect(codes).toContain('REVIEW_VERDICT_IGNORED');
    expect(codes).toContain('CORE_MISMATCH');
  });

  it('refuses a guidance slot bound from anything but the plan notes', () => {
    for (const binding of [
      { from: 'context.scratch.g' },
      { from: 'nodes.research.output' },
      { literal: 'do evil' },
      { default: 'x', from: 'context.planNotes' },
    ]) {
      const raw = plan((r) => {
        r.nodes.implement = {
          ...r.nodes.implement,
          inputs: { ...(r.nodes.implement?.inputs as object), guidance: binding },
        };
      });
      expect(codesOf(raw), JSON.stringify(binding)).toContain('CORE_MISMATCH');
    }
  });
});

describe('the free ends stay out of the core', () => {
  it('refuses an edge from a free node into the middle of the core', () => {
    const raw = plan((r) => {
      r.nodes.research = {
        expr: 'context.scratch.fast == true',
        onFalse: 'implement',
        onTrue: 'openPR',
        type: 'cond',
      };
    });
    expect(codesOf(raw)).toContain('CORE_ENTERED_MIDWAY');
  });

  it('refuses a plan that starts inside the core', () => {
    const raw = plan((r) => {
      r.entry = 'review';
    });
    expect(codesOf(raw)).toContain('CORE_ENTERED_MIDWAY');
  });

  it('refuses a pre-region node that points at the post-merge return', () => {
    const raw = plan((r) => {
      r.nodes.research = {
        expr: 'context.scratch.x == true',
        onFalse: 'implement',
        onTrue: 'commitLesson',
        type: 'cond',
      };
    });
    expect(codesOf(raw)).toContain('CORE_ENTERED_MIDWAY');
  });

  it('refuses a free node placed between core nodes', () => {
    const raw = plan((r) => {
      r.nodes.checkApproval = { ...r.nodes.checkApproval, onTrue: 'polish' };
      r.nodes.polish = {
        agentRef: 'contentWriter',
        inputs: { goal: { from: 'request.description' } },
        next: 'forgetRejection',
        type: 'agent',
      };
    });
    const codes = codesOf(raw);
    expect(codes).toContain('CORE_MISMATCH');
    expect(codes).toContain('FREE_NODE_IN_CORE');
    expect(codes).toContain('CORE_ENTERED_MIDWAY');
  });

  it('refuses a node that reuses a core id for something else', () => {
    const raw = plan((r) => {
      r.nodes.review = {
        agentRef: 'contentWriter',
        inputs: { goal: { from: 'request.description' } },
        next: 'checkApproval',
        type: 'agent',
      };
    });
    expect(codesOf(raw)).toContain('CORE_MISMATCH');
  });

  it('refuses a free node that ends the run SUCCESS without the core', () => {
    const raw = plan((r) => {
      r.nodes.research = {
        expr: 'context.scratch.x == true',
        onFalse: 'implement',
        onTrue: 'earlyDone',
        type: 'cond',
      };
      r.nodes.earlyDone = { status: 'SUCCESS', type: 'terminate' };
    });
    expect(codesOf(raw)).toContain('COND_BYPASS');
  });

  it('refuses types and steps the free ends may not have', () => {
    const signal = plan((r) => {
      r.nodes.research = {
        name: 'humanMergeSignal',
        onReceive: 'implement',
        onTimeout: 'stop',
        timeout: '1h',
        type: 'signal',
      };
      r.nodes.stop = { status: 'FAILED', type: 'terminate' };
    });
    expect(codesOf(signal)).toContain('FREE_NODE_TYPE_DENIED');
    for (const step of [
      'executeImplementation',
      'executeReviewFixImplementation',
      'runReviewNetwork',
      'runTests',
      'createOrUpdatePullRequest',
      'commitToMemory',
    ]) {
      const raw = plan((r) => {
        r.nodes.research = { next: 'implement', step, type: 'step' };
      });
      expect(codesOf(raw), step).toContain('FREE_STEP_DENIED');
    }
  });

  it('keeps the post-merge region read-only', () => {
    const hook = (node: Record<string, unknown>): RawSpec =>
      plan((r) => {
        r.nodes.waitForHumanMerge = { ...r.nodes.waitForHumanMerge, onReceive: 'after' };
        r.nodes.after = node;
      });
    expect(codesOf(hook({ next: 'commitLesson', step: 'runTests', type: 'step' }))).toContain(
      'FREE_STEP_DENIED'
    );
    expect(
      codesOf(hook({ next: 'commitLesson', step: 'validateContext', type: 'step' }))
    ).toContain('FREE_STEP_DENIED');
    expect(
      codesOf(
        hook({
          agentRef: 'contentWriter',
          inputs: { goal: { from: 'request.description' } },
          next: 'commitLesson',
          storeAs: 'context.planNotes',
          type: 'agent',
        })
      )
    ).toContain('FREE_WRITE_DENIED');
    expect(
      codesOf(
        hook({
          agentRef: 'contentWriter',
          inputs: { goal: { from: 'request.description' } },
          next: 'implement',
          type: 'agent',
        })
      )
    ).toContain('CORE_ENTERED_MIDWAY');
    expect(
      codesOf(
        hook({
          agentRef: 'contentWriter',
          inputs: { goal: { from: 'request.description' } },
          next: 'research',
          type: 'agent',
        })
      )
    ).toContain('POST_REGION_ESCAPE');
  });

  it('refuses a hook that points at a node that also runs before the core', () => {
    const raw = plan((r) => {
      r.nodes.waitForHumanMerge = { ...r.nodes.waitForHumanMerge, onReceive: 'research' };
    });
    expect(codesOf(raw)).toContain('POST_HOOK_INVALID');
  });

  it('refuses any other route out of the core to a free node', () => {
    const raw = plan((r) => {
      r.nodes.waitForHumanMerge = { ...r.nodes.waitForHumanMerge, onTimeout: 'after' };
      r.nodes.after = {
        agentRef: 'contentWriter',
        inputs: { goal: { from: 'request.description' } },
        next: 'commitLesson',
        type: 'agent',
      };
    });
    const codes = codesOf(raw);
    expect(codes).toContain('FREE_NODE_IN_CORE');
    expect(codes).toContain('CORE_MISMATCH');
  });
});

describe('the one channel: context.planNotes', () => {
  it('lets the pre-region write the notes and nothing else the core reads', () => {
    expect(codesOf(canonicalDeliveringRaw())).toEqual([]);
    const set = plan((r) => {
      r.nodes.research = {
        agentRef: 'productAnalyst',
        inputs: { goal: { from: 'request.description' } },
        next: 'notes',
        type: 'agent',
      };
      r.nodes.notes = {
        next: 'gatherTicket',
        type: 'set',
        values: { 'context.planNotes': { from: 'nodes.research.output' } },
      };
    });
    expect(codesOf(set)).toEqual([]);
  });

  it('refuses the notes bound into a review input, the criteria or the ticket', () => {
    const into = (node: string, key: string): RawSpec =>
      plan((r) => {
        r.nodes[node] = {
          ...r.nodes[node],
          inputs: {
            ...(r.nodes[node]?.inputs as object),
            [key]: { from: 'context.planNotes' },
          },
        };
      });
    for (const [node, key] of [
      ['review', 'successCriteria'],
      ['review', 'codeResult'],
      ['implement', 'ticket'],
      ['implement', 'successCriteria'],
      ['openPR', 'codeResult'],
    ] as const) {
      const codes = codesOf(into(node, key));
      expect(codes, `${node}.${key}`).toContain('CORE_MISMATCH');
    }
  });

  it('refuses a pre-region write to anything the core reads', () => {
    for (const path of [
      'context.currentCodeResult',
      'context.lastRejectionSummary',
      'context.lastReviewFingerprint',
      'context.lastCILogs',
      'context.ciResultPayload',
      'context.prUrl',
      'context.ciRetries',
    ]) {
      const raw = plan((r) => {
        r.nodes.research = {
          agentRef: 'productAnalyst',
          inputs: { goal: { from: 'request.description' } },
          next: 'implement',
          storeAs: path,
          type: 'agent',
        };
      });
      expect(codesOf(raw), path).toContain('FREE_WRITE_DENIED');
    }
  });
});

describe('adversarial repros', () => {
  it('A1: a fix step between the approval and a second review, with no storeAs', () => {
    const raw = plan((r) => {
      r.nodes.checkApproval = { ...r.nodes.checkApproval, onTrue: 'polish' };
      r.nodes.polish = {
        next: 'review2',
        step: 'executeReviewFixImplementation',
        type: 'step',
      };
      r.nodes.review2 = { next: 'forgetRejection', step: 'runReviewNetwork', type: 'step' };
    });
    const codes = codesOf(raw);
    expect(codes).toContain('CORE_MISMATCH');
    expect(codes).toContain('FREE_NODE_IN_CORE');
    expect(codes).toContain('FREE_STEP_DENIED');
  });

  it('A2: a fix stores its output and a set then rolls context.currentCodeResult back', () => {
    const raw = plan((r) => {
      r.nodes.checkApproval = { ...r.nodes.checkApproval, onTrue: 'polish' };
      r.nodes.polish = {
        next: 'rollback',
        step: 'executeReviewFixImplementation',
        storeAs: 'context.currentCodeResult',
        type: 'step',
      };
      r.nodes.rollback = {
        next: 'forgetRejection',
        type: 'set',
        values: { 'context.currentCodeResult': { from: 'nodes.implement.output' } },
      };
    });
    const codes = codesOf(raw);
    expect(codes).toContain('FREE_WRITE_DENIED');
    expect(codes).toContain('FREE_STEP_DENIED');
    expect(codes).toContain('CORE_MISMATCH');
  });

  it('A3: a node id with dots that overwrites the review verdict', () => {
    const raw = plan((r) => {
      r.nodes.research = {
        agentRef: 'productAnalyst',
        inputs: { goal: { from: 'request.description' } },
        next: 'review.output.approved',
        type: 'agent',
      };
      r.nodes['review.output.approved'] = {
        expr: 'nodes.review.output.approved == false',
        onFalse: 'implement',
        onTrue: 'implement',
        type: 'cond',
      };
    });
    expect(codesOf(raw)).toContain('NODE_ID_INVALID');
  });

  it('A3b: a set node with that id and a visit bound', () => {
    const raw = plan((r) => {
      r.nodes.research = {
        agentRef: 'productAnalyst',
        inputs: { goal: { from: 'request.description' } },
        next: 'review.output.approved',
        type: 'agent',
      };
      r.nodes['review.output.approved'] = {
        maxVisits: 2,
        next: 'implement',
        onExhausted: 'implement',
        type: 'set',
        values: { 'context.scratch.x': { literal: 1 } },
      };
    });
    expect(codesOf(raw)).toContain('NODE_ID_INVALID');
  });

  it.each(['a.b', 'a[0]', 'a]', '1abc', '_x', 'constructor', 'a b'])(
    'refuses the node id %j in either mode',
    (id) => {
      const delivering = plan((r) => {
        r.nodes.research = {
          agentRef: 'productAnalyst',
          inputs: { goal: { from: 'request.description' } },
          next: id,
          type: 'agent',
        };
        r.nodes[id] = {
          next: 'implement',
          type: 'set',
          values: { 'context.scratch.n': { literal: 1 } },
        };
      });
      expect(codesOf(delivering)).toContain('NODE_ID_INVALID');
      const output = outputOnlyRaw();
      output.nodes[id] = {
        next: 'done',
        type: 'set',
        values: { 'context.scratch.n': { literal: 1 } },
      };
      output.nodes.draft = { ...output.nodes.draft, next: id };
      output.nodes[id] = { ...output.nodes[id], next: 'reviewDraft' };
      expect(codesOf(output, 'output-only')).toContain('NODE_ID_INVALID');
    }
  );

  it('A4: a gate fix after the approval, steered by agent text through parseAgentOutput', () => {
    const raw = plan((r) => {
      r.nodes.checkApproval = { ...r.nodes.checkApproval, onTrue: 'parse' };
      r.nodes.parse = { next: 'gateFix', step: 'parseAgentOutput', type: 'step' };
      r.nodes.gateFix = {
        inputs: { gateOutput: { from: 'nodes.parse.output' } },
        next: 'forgetRejection',
        step: 'executeGateFixImplementation',
        storeAs: 'context.currentCodeResult',
        type: 'step',
      };
    });
    const codes = codesOf(raw);
    expect(codes).toContain('FREE_STEP_DENIED');
    expect(codes).toContain('CORE_MISMATCH');
    expect(codes).toContain('FREE_NODE_IN_CORE');
  });

  it('A5: agent output stored into the rejection summary or the CI logs, then commitToMemory', () => {
    for (const path of ['context.lastRejectionSummary', 'context.lastCILogs']) {
      const raw = plan((r) => {
        r.nodes.research = {
          agentRef: 'productAnalyst',
          inputs: { goal: { from: 'request.description' } },
          next: 'lesson',
          storeAs: path,
          type: 'agent',
        };
        r.nodes.lesson = { next: 'implement', step: 'commitToMemory', type: 'step' };
      });
      const codes = codesOf(raw);
      expect(codes, path).toContain('CONTEXT_WRITE_DENIED');
      expect(codes, path).toContain('FREE_WRITE_DENIED');
      expect(codes, path).toContain('FREE_STEP_DENIED');
    }
  });

  it('A6: an agent stores ["Pre-approved"] into the success criteria or the ticket', () => {
    for (const path of ['context.successCriteria', 'context.ticket']) {
      const viaAgent = plan((r) => {
        r.nodes.research = {
          agentRef: 'productAnalyst',
          inputs: { goal: { from: 'request.description' } },
          next: 'implement',
          storeAs: path,
          type: 'agent',
        };
      });
      expect(codesOf(viaAgent), path).toContain('CONTEXT_WRITE_DENIED');
      const viaSet = plan((r) => {
        r.nodes.research = {
          agentRef: 'productAnalyst',
          inputs: { goal: { from: 'request.description' } },
          next: 'stamp',
          type: 'agent',
        };
        r.nodes.stamp = {
          next: 'implement',
          type: 'set',
          values: { [path]: { literal: ['Pre-approved'] } },
        };
      });
      expect(codesOf(viaSet), path).toContain('CONTEXT_WRITE_DENIED');
      const viaOutput = plan((r) => {
        r.nodes.research = {
          agentRef: 'productAnalyst',
          inputs: { goal: { from: 'request.description' } },
          next: 'stamp',
          type: 'agent',
        };
        r.nodes.stamp = {
          next: 'implement',
          type: 'set',
          values: { [path]: { from: 'nodes.research.output' } },
        };
      });
      expect(codesOf(viaOutput), path).toContain('CONTEXT_WRITE_DENIED');
    }
  });

  it('refuses validation fed with agent text, which would launder it into the criteria', () => {
    const raw = plan((r) => {
      r.nodes.research = {
        agentRef: 'productAnalyst',
        inputs: { goal: { from: 'request.description' } },
        next: 'validate',
        type: 'agent',
      };
      r.nodes.validate = {
        inputs: { ticket: { from: 'nodes.research.output' } },
        next: 'implement',
        step: 'validateContext',
        type: 'step',
      };
    });
    expect(codesOf(raw)).toContain('INPUT_SOURCE_NOT_ALLOWED');
  });
});

describe('applySkeletonPolicy refuses a reserved id', () => {
  it('does not attach a core to a pre-region that uses a core id for something else', () => {
    const raw: RawSpec = {
      description: 'fixture',
      entry: 'review',
      name: 'fixture-reserved',
      nodes: {
        end: { status: 'SUCCESS', type: 'terminate' },
        review: {
          agentRef: 'productAnalyst',
          inputs: { goal: { from: 'request.description' } },
          next: 'end',
          type: 'agent',
        },
      },
      schemaVersion: 1,
    };
    const result = applySkeletonPolicy(parse(raw), 'delivering');
    expect(result.injected).toEqual([]);
    expect(result.report.errors.map((e) => e.code)).toContain('CORE_MISMATCH');
  });
});

describe('output-only: no agent after the last human review', () => {
  const twoAgents = (edit: Edit): RawSpec => {
    const raw = outputOnlyRaw();
    raw.nodes.draft = {
      agentRef: 'contentWriter',
      inputs: { goal: { from: 'request.description' } },
      next: 'reviewDraft',
      type: 'agent',
    };
    raw.nodes.reviewDraft = { ...raw.nodes.reviewDraft, onSubmit: 'polish' };
    raw.nodes.polish = {
      agentRef: 'contentWriter',
      inputs: { goal: { from: 'request.description' } },
      next: 'done',
      type: 'agent',
    };
    edit(raw);
    return raw;
  };

  it('refuses agent -> humanReview -> agent2 -> SUCCESS', () => {
    expect(
      codesOf(
        twoAgents(() => {}),
        'output-only'
      )
    ).toContain('AGENT_AFTER_REVIEW');
  });

  it('refuses it when the late agent is the same agent looping back', () => {
    const raw = outputOnlyRaw();
    raw.nodes.reviewDraft = { ...raw.nodes.reviewDraft, onSubmit: 'draft2' };
    raw.nodes.draft2 = {
      agentRef: 'contentWriter',
      inputs: { goal: { from: 'request.description' } },
      next: 'done',
      type: 'agent',
    };
    expect(codesOf(raw, 'output-only')).toContain('AGENT_AFTER_REVIEW');
  });

  it('accepts a second agent when a second review of its output follows', () => {
    const raw = twoAgents((r) => {
      r.nodes.polish = {
        agentRef: 'contentWriter',
        inputs: { goal: { from: 'request.description' } },
        next: 'review2',
        type: 'agent',
      };
      r.nodes.review2 = {
        contentFrom: 'nodes.polish.output',
        onSubmit: 'done',
        onTimeout: 'timedOut',
        timeout: '7d',
        title: 'Review the polish',
        type: 'humanReview',
      };
    });
    expect(codesOf(raw, 'output-only')).toEqual([]);
  });

  it('accepts a late agent that cannot reach SUCCESS', () => {
    const raw = twoAgents((r) => {
      r.nodes.polish = {
        agentRef: 'contentWriter',
        inputs: { goal: { from: 'request.description' } },
        next: 'timedOut',
        type: 'agent',
      };
      r.nodes.reviewDraft = {
        ...r.nodes.reviewDraft,
        onSubmit: 'done',
        onTimeout: 'polish',
      };
    });
    expect(codesOf(raw, 'output-only')).not.toContain('AGENT_AFTER_REVIEW');
  });
});

describe('the validate phase is the shipped one, whole', () => {
  const mismatch = (raw: RawSpec): boolean => codesOf(raw).includes('VALIDATE_PHASE_MISMATCH');

  it('refuses a lone validateContext step with no gather, actionability stop or criteria write', () => {
    const lone = plan((r) => {
      for (const id of [
        'gatherTicket',
        'setTicket',
        'checkActionable',
        'terminateNotActionable',
        'setSuccessCriteria',
      ]) {
        delete r.nodes[id];
      }
      r.nodes.research = { ...r.nodes.research, next: 'validate' };
      r.nodes.validate = {
        next: 'implement',
        onError: 'continue',
        step: 'validateContext',
        type: 'step',
      };
    });
    expect(mismatch(lone)).toBe(true);
  });

  it.each(['gatherTicket', 'setTicket', 'validate', 'checkActionable', 'setSuccessCriteria'])(
    'refuses an edit to validate-phase node %s',
    (id) => {
      const raw = plan((r) => {
        r.nodes[id] = { ...r.nodes[id], title: 'Edited' };
      });
      expect(mismatch(raw)).toBe(true);
    }
  );

  it('refuses a second validateContext step beside the phase', () => {
    const raw = plan((r) => {
      r.nodes.research = { ...r.nodes.research, next: 'extra' };
      r.nodes.extra = { next: 'gatherTicket', step: 'validateContext', type: 'step' };
    });
    expect(mismatch(raw)).toBe(true);
  });

  it('passes the unedited phase, and the generator path injects it for a pre-region with none', () => {
    expect(mismatch(canonicalDeliveringRaw())).toBe(false);
    const applied = applySkeletonPolicy(
      parse({
        description: 'x',
        entry: 'research',
        name: 'x',
        nodes: {
          done: { status: 'SUCCESS', type: 'terminate' },
          research: {
            agentRef: 'productAnalyst',
            inputs: { goal: { from: 'request.description' } },
            next: 'done',
            type: 'agent',
          },
        },
        schemaVersion: 1,
      } as unknown as RawSpec),
      'delivering'
    );
    expect(applied.report.errors).toEqual([]);
    expect(applied.injected).toContain('setSuccessCriteria');
  });

  it('refuses, after generation, a pre-region that wrote only a lone validateContext', () => {
    const applied = applySkeletonPolicy(
      parse({
        description: 'x',
        entry: 'validate',
        name: 'x',
        nodes: {
          done: { status: 'SUCCESS', type: 'terminate' },
          validate: { next: 'done', step: 'validateContext', type: 'step' },
        },
        schemaVersion: 1,
      } as unknown as RawSpec),
      'delivering'
    );
    expect(applied.report.errors.map((e) => e.code)).toContain('VALIDATE_PHASE_MISMATCH');
  });
});
