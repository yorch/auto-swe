/**
 * Repros from the third adversarial round on the canonical-core policy. Every hostile case was
 * reproduced against the real interpreter before the rule that refuses it was written; each must
 * be REFUSED with the code named, and the positive control beside it must pass, so a policy that
 * refuses everything cannot satisfy this file.
 */

import { describe, expect, it } from 'vitest';
import {
  canonicalDeliveringRaw,
  clone,
  outputOnlyRaw,
  parse,
  type RawSpec,
} from './skeletonFixtures.js';
import { checkSkeletonPolicy, type SkeletonMode } from './skeletonPolicy.js';

function codesOf(raw: RawSpec, mode: SkeletonMode = 'delivering'): string[] {
  return checkSkeletonPolicy(parse(clone(raw)), mode).errors.map((e) => e.code);
}

function plan(edit: (raw: RawSpec) => void): RawSpec {
  const raw = canonicalDeliveringRaw();
  edit(raw);
  return raw;
}

function outputOnly(edit: (raw: RawSpec) => void): RawSpec {
  const raw = outputOnlyRaw();
  edit(raw);
  return raw;
}

/** A pre-region cond that loops on itself `visits` times, then goes on to validation. */
function spin(raw: RawSpec, id: string, visits: number, onFalse: string): void {
  raw.nodes[id] = {
    expr: 'true',
    maxVisits: visits,
    onExhausted: onFalse,
    onFalse,
    onTrue: id,
    type: 'cond',
  };
}

describe('M1: the transition cap is shared by the whole walk', () => {
  it('refuses a pre-region that burns the cap before the core runs (repro: maxVisits 488)', () => {
    const raw = plan((r) => {
      r.nodes.research = { ...r.nodes.research, next: 'spin' };
      spin(r, 'spin', 488, 'validate');
    });
    expect(codesOf(raw)).toContain('TRANSITION_BUDGET_EXCEEDED');
  });

  it('refuses a pre-region that skips validation through the same spin (the original repro)', () => {
    const raw = plan((r) => {
      r.nodes.research = { ...r.nodes.research, next: 'spin' };
      spin(r, 'spin', 488, 'implement');
    });
    expect(codesOf(raw)).toContain('TRANSITION_BUDGET_EXCEEDED');
  });

  it('refuses a post-merge region that does the same', () => {
    const raw = plan((r) => {
      r.nodes.waitForHumanMerge = { ...r.nodes.waitForHumanMerge, onReceive: 'spin' };
      spin(r, 'spin', 488, 'commitLesson');
    });
    expect(codesOf(raw)).toContain('TRANSITION_BUDGET_EXCEEDED');
  });

  it('adds up several loops that are each modest', () => {
    const raw = plan((r) => {
      r.nodes.research = { ...r.nodes.research, next: 'spinA' };
      spin(r, 'spinA', 120, 'spinB');
      spin(r, 'spinB', 120, 'spinC');
      spin(r, 'spinC', 120, 'validate');
    });
    expect(codesOf(raw)).toContain('TRANSITION_BUDGET_EXCEEDED');
  });

  it('refuses a loop in a free region that nothing bounds', () => {
    const raw = plan((r) => {
      r.nodes.research = { ...r.nodes.research, next: 'a' };
      r.nodes.a = { next: 'b', type: 'set', values: {} };
      r.nodes.b = {
        expr: 'true',
        onFalse: 'validate',
        onTrue: 'a',
        type: 'cond',
      };
    });
    const codes = codesOf(raw);
    expect(codes).toContain('LOOP_UNBOUNDED');
    expect(codes).toContain('TRANSITION_BUDGET_EXCEEDED');
  });

  it('passes loops that leave the core its share (positive control)', () => {
    const raw = plan((r) => {
      r.nodes.research = { ...r.nodes.research, next: 'spin' };
      spin(r, 'spin', 20, 'gatherTicket');
      r.nodes.waitForHumanMerge = { ...r.nodes.waitForHumanMerge, onReceive: 'spinPost' };
      spin(r, 'spinPost', 20, 'commitLesson');
    });
    expect(codesOf(raw)).toEqual([]);
  });
});

describe('M2: what the run returns is what a human reviewed (output-only)', () => {
  const hidden = (r: RawSpec): void => {
    r.nodes.draft = { ...r.nodes.draft, next: 'hidden' };
    r.nodes.hidden = {
      agentRef: 'contentWriter',
      inputs: { goal: { from: 'request.description' } },
      next: 'reviewDraft',
      type: 'agent',
    };
    r.nodes.done = {
      result: { text: { from: 'nodes.hidden.output' } },
      status: 'SUCCESS',
      type: 'terminate',
    };
  };

  it('refuses a result bound to an agent whose output no review showed (repro)', () => {
    expect(codesOf(outputOnly(hidden), 'output-only')).toContain('RESULT_UNREVIEWED');
  });

  it('refuses the same result laundered through a scratch path or an expression', () => {
    const viaScratch = outputOnly((r) => {
      r.nodes.draft = { ...r.nodes.draft, next: 'hidden' };
      r.nodes.hidden = {
        agentRef: 'contentWriter',
        inputs: { goal: { from: 'request.description' } },
        next: 'reviewDraft',
        storeAs: 'context.scratch.text',
        type: 'agent',
      };
      r.nodes.done = {
        result: { text: { from: 'context.scratch.text' } },
        status: 'SUCCESS',
        type: 'terminate',
      };
    });
    expect(codesOf(viaScratch, 'output-only')).toContain('RESULT_UNREVIEWED');
    const viaExpr = outputOnly((r) => {
      r.nodes.done = {
        result: { text: { expr: 'nodes.draft.output' } },
        status: 'SUCCESS',
        type: 'terminate',
      };
    });
    expect(codesOf(viaExpr, 'output-only')).toContain('RESULT_UNREVIEWED');
  });

  it('refuses a result from an agent the reviewing step does not dominate', () => {
    const raw = outputOnly((r) => {
      // draft -> route -> (reviewDraft | skip) ; skip also ends SUCCESS with the draft's text.
      r.nodes.draft = { ...r.nodes.draft, next: 'route' };
      r.nodes.route = {
        expr: 'context.scratch.fast == true',
        onFalse: 'reviewDraft',
        onTrue: 'fastDone',
        type: 'cond',
      };
      r.nodes.fastDone = {
        result: { text: { from: 'nodes.draft.output' } },
        status: 'SUCCESS',
        type: 'terminate',
      };
    });
    const codes = codesOf(raw, 'output-only');
    expect(codes).toContain('RESULT_UNREVIEWED');
    expect(codes).toContain('COND_BYPASS');
  });

  it('passes a result of the reviewed output, a literal and the request (positive control)', () => {
    const raw = outputOnly((r) => {
      r.nodes.done = {
        result: {
          ask: { from: 'request.description' },
          note: { literal: 'reviewed' },
          text: { from: 'nodes.draft.output' },
          title: { default: '', from: 'nodes.draft.output.title' },
        },
        status: 'SUCCESS',
        type: 'terminate',
      };
    });
    expect(codesOf(raw, 'output-only')).toEqual([]);
  });

  it('passes two agents when a review shows each (positive control)', () => {
    const raw = outputOnly((r) => {
      r.nodes.reviewDraft = { ...r.nodes.reviewDraft, onSubmit: 'second' };
      r.nodes.second = {
        agentRef: 'contentWriter',
        inputs: { goal: { from: 'request.description' } },
        next: 'reviewSecond',
        type: 'agent',
      };
      r.nodes.reviewSecond = {
        contentFrom: 'nodes.second.output',
        onSubmit: 'done',
        onTimeout: 'timedOut',
        timeout: '7d',
        title: 'Review the second',
        type: 'humanReview',
      };
      r.nodes.done = {
        result: { a: { from: 'nodes.draft.output' }, b: { from: 'nodes.second.output' } },
        status: 'SUCCESS',
        type: 'terminate',
      };
    });
    // The first agent's review dominates `done`, and so does the second's.
    expect(codesOf(raw, 'output-only')).toEqual([]);
  });

  it('refuses a blind approval whose contextFrom shows nothing an agent produced (repro)', () => {
    const approval = (contextFrom?: string): RawSpec =>
      outputOnly((r) => {
        r.nodes.reviewDraft = {
          ...(contextFrom === undefined ? {} : { contextFrom }),
          onApprove: 'done',
          onReject: 'timedOut',
          onTimeout: 'timedOut',
          timeout: '7d',
          title: 'Approve',
          type: 'humanApproval',
        };
      });
    expect(codesOf(approval('context.scratch.none'), 'output-only')).toContain(
      'HUMAN_REVIEW_CONTENT_UNBOUND'
    );
    expect(codesOf(approval(undefined), 'output-only')).toContain('HUMAN_REVIEW_CONTENT_UNBOUND');
    expect(codesOf(approval('nodes.draft.output.nonexistent'), 'output-only')).toContain(
      'HUMAN_REVIEW_CONTENT_UNBOUND'
    );
    expect(codesOf(approval('nodes.draft.output'), 'output-only')).toEqual([]);
  });

  it('refuses an approval that names an agent that has not run yet', () => {
    const raw = outputOnly((r) => {
      r.nodes.reviewDraft = {
        contextFrom: 'nodes.late.output',
        onApprove: 'late',
        onReject: 'timedOut',
        onTimeout: 'timedOut',
        timeout: '7d',
        title: 'Approve',
        type: 'humanApproval',
      };
      r.nodes.late = {
        agentRef: 'contentWriter',
        inputs: { goal: { from: 'request.description' } },
        next: 'done',
        type: 'agent',
      };
    });
    expect(codesOf(raw, 'output-only')).not.toEqual([]);
  });

  it('refuses a humanReview whose contentFrom is a subpath of an agent output', () => {
    const raw = outputOnly((r) => {
      r.nodes.reviewDraft = {
        ...r.nodes.reviewDraft,
        contentFrom: 'nodes.draft.output.nonexistent',
      };
    });
    expect(codesOf(raw, 'output-only')).toContain('HUMAN_REVIEW_CONTENT_UNBOUND');
  });
});

describe('L1: the review is judged against what validation extracted', () => {
  const validated = (edit: (r: RawSpec) => void): RawSpec =>
    plan((r) => {
      edit(r);
    });
  // Routes the shipped phase's last step through a hostile `keep` node instead of the canonical one.
  const viaKeep = (r: RawSpec): void => {
    r.nodes.setSuccessCriteria = { ...r.nodes.setSuccessCriteria, next: 'keep' };
  };

  it('passes the criteria copied from validate.output.successCriteria (positive control)', () => {
    expect(codesOf(validated(() => {}))).toEqual([]);
  });

  it('refuses the criteria copied from another field of the validation (repro: ambiguities)', () => {
    const raw = validated((r) => {
      viaKeep(r);
      r.nodes.keep = {
        next: 'implement',
        type: 'set',
        values: {
          'context.successCriteria': { default: [], from: 'nodes.validate.output.ambiguities' },
        },
      };
    });
    expect(codesOf(raw)).toContain('CONTEXT_WRITE_DENIED');
  });

  it('refuses the whole validation output stored into the criteria, or no field at all', () => {
    const stored = validated((r) => {
      r.nodes.validate = { ...r.nodes.validate, storeAs: 'context.successCriteria' };
    });
    expect(codesOf(stored)).toContain('CONTEXT_WRITE_DENIED');
    const whole = validated((r) => {
      viaKeep(r);
      r.nodes.keep = {
        next: 'implement',
        type: 'set',
        values: { 'context.successCriteria': { from: 'nodes.validate.output' } },
      };
    });
    expect(codesOf(whole)).toContain('CONTEXT_WRITE_DENIED');
  });

  it('takes the ticket from the gatherer text field only', () => {
    const gathered = (from: string): RawSpec =>
      plan((r) => {
        r.nodes.setTicket = {
          ...r.nodes.setTicket,
          values: { 'context.ticket': { default: '', from } },
        };
      });
    expect(codesOf(gathered('nodes.gatherTicket.output.text'))).toEqual([]);
    expect(codesOf(gathered('nodes.gatherTicket.output.unavailableReason'))).toContain(
      'CONTEXT_WRITE_DENIED'
    );
  });

  it('refuses a way into the core that skips validation', () => {
    // research -> (validate | implement): one branch reaches the core with no validateContext run.
    const branch = plan((r) => {
      r.nodes.research = { ...r.nodes.research, next: 'route' };
      r.nodes.route = {
        expr: 'context.scratch.skip == true',
        onFalse: 'gatherTicket',
        onTrue: 'implement',
        type: 'cond',
      };
    });
    expect(codesOf(branch)).toContain('VALIDATE_MISSING');
    const none = plan((r) => {
      r.nodes.research = { ...r.nodes.research, next: 'implement' };
    });
    expect(codesOf(none)).toContain('VALIDATE_MISSING');
    const startsInCore = plan((r) => {
      r.entry = 'implement';
    });
    expect(codesOf(startsInCore)).toContain('VALIDATE_MISSING');
  });

  it('refuses a free cond that skips the validate phase entry (VALIDATE_ENTRY_BYPASSED)', () => {
    // onTrue goes straight to `validate`, past the gather and the actionability stop.
    const skipFirst = plan((r) => {
      r.nodes.research = { ...r.nodes.research, next: 'route' };
      r.nodes.route = {
        expr: 'context.scratch.skip == true',
        onFalse: 'gatherTicket',
        onTrue: 'validate',
        type: 'cond',
      };
    });
    expect(codesOf(skipFirst)).toContain('VALIDATE_ENTRY_BYPASSED');
    // The same shape toward any later phase node.
    const skipSet = plan((r) => {
      r.nodes.research = { ...r.nodes.research, next: 'route' };
      r.nodes.route = {
        expr: 'context.scratch.skip == true',
        onFalse: 'gatherTicket',
        onTrue: 'setTicket',
        type: 'cond',
      };
    });
    expect(codesOf(skipSet)).toContain('VALIDATE_ENTRY_BYPASSED');
    // Positive controls: both branches through the entry, and the plain plan.
    expect(codesOf(plan(() => {}))).not.toContain('VALIDATE_ENTRY_BYPASSED');
    const both = plan((r) => {
      r.nodes.research = { ...r.nodes.research, next: 'route' };
      r.nodes.route = {
        expr: 'context.scratch.skip == true',
        onFalse: 'gatherTicket',
        onTrue: 'gatherTicket',
        type: 'cond',
      };
    });
    expect(codesOf(both)).not.toContain('VALIDATE_ENTRY_BYPASSED');
  });

  it('passes a validation that sits behind a branch both ways lead through (positive control)', () => {
    const raw = plan((r) => {
      r.nodes.research = { ...r.nodes.research, next: 'route' };
      r.nodes.route = {
        expr: 'context.scratch.deep == true',
        onFalse: 'gatherTicket',
        onTrue: 'deep',
        type: 'cond',
      };
      r.nodes.deep = {
        agentRef: 'productAnalyst',
        inputs: { goal: { from: 'request.description' } },
        next: 'gatherTicket',
        type: 'agent',
      };
    });
    expect(codesOf(raw)).toEqual([]);
  });
});

describe('L2: the merge lesson is not skippable after the merge', () => {
  const hooked = (edit: (r: RawSpec) => void): RawSpec =>
    plan((r) => {
      r.nodes.waitForHumanMerge = { ...r.nodes.waitForHumanMerge, onReceive: 'after' };
      edit(r);
    });

  it('refuses a post-merge terminate that ends SUCCESS itself (repro)', () => {
    const raw = hooked((r) => {
      r.nodes.after = { status: 'SUCCESS', type: 'terminate' };
    });
    expect(codesOf(raw)).toContain('POST_ENDS_SUCCESS');
  });

  it('refuses a post-merge node with no next, which the interpreter ends SUCCESS', () => {
    const raw = hooked((r) => {
      r.nodes.after = {
        agentRef: 'contentWriter',
        inputs: { goal: { from: 'request.description' } },
        type: 'agent',
      };
    });
    expect(codesOf(raw)).toContain('POST_ENDS_SUCCESS');
  });

  it('refuses a post-merge branch where one side returns and the other ends SUCCESS', () => {
    const raw = hooked((r) => {
      r.nodes.after = {
        expr: 'context.scratch.quick == true',
        onFalse: 'commitLesson',
        onTrue: 'quickDone',
        type: 'cond',
      };
      r.nodes.quickDone = { status: 'SUCCESS', type: 'terminate' };
    });
    expect(codesOf(raw)).toContain('POST_ENDS_SUCCESS');
  });

  it('refuses a post-merge failure or exhaustion route that ends SUCCESS', () => {
    const raw = hooked((r) => {
      r.nodes.after = {
        agentRef: 'contentWriter',
        inputs: { goal: { from: 'request.description' } },
        next: 'commitLesson',
        onFailure: { status: 'SUCCESS' },
        type: 'agent',
      };
    });
    expect(codesOf(raw)).toContain('POST_ENDS_SUCCESS');
  });

  it('passes a post-merge region that returns to the lesson, and one that ends FAILED (controls)', () => {
    const returns = hooked((r) => {
      r.nodes.after = {
        agentRef: 'contentWriter',
        inputs: { goal: { from: 'request.description' } },
        next: 'commitLesson',
        type: 'agent',
      };
    });
    expect(codesOf(returns)).toEqual([]);
    const fails = hooked((r) => {
      r.nodes.after = {
        expr: 'context.scratch.stop == true',
        onFalse: 'commitLesson',
        onTrue: 'stop',
        type: 'cond',
      };
      r.nodes.stop = { status: 'FAILED', type: 'terminate' };
    });
    expect(codesOf(fails)).toEqual([]);
  });
});

describe('L3: a free node cannot fake the dashboard status', () => {
  const stamped = (status: string, where: 'pre' | 'post'): RawSpec =>
    plan((r) => {
      if (where === 'pre') {
        r.nodes.research = { ...r.nodes.research, status };
      } else {
        r.nodes.waitForHumanMerge = { ...r.nodes.waitForHumanMerge, onReceive: 'after' };
        r.nodes.after = {
          agentRef: 'contentWriter',
          inputs: { goal: { from: 'request.description' } },
          next: 'commitLesson',
          status,
          type: 'agent',
        };
      }
    });

  it.each([
    'AWAITING_HUMAN_MERGE',
    'IN_REVIEW',
    'AWAITING_CI',
    'IMPLEMENTING',
    'COMPLETED',
    'MERGED',
  ])('refuses %s on a pre-region and a post-merge node', (status) => {
    expect(codesOf(stamped(status, 'pre'))).toContain(
      status === 'COMPLETED' ? 'STATUS_TERMINAL' : 'FREE_STATUS_DENIED'
    );
    expect(codesOf(stamped(status, 'post'))).toContain(
      status === 'COMPLETED' ? 'STATUS_TERMINAL' : 'FREE_STATUS_DENIED'
    );
  });

  it('refuses it in an output-only plan too', () => {
    const raw = outputOnly((r) => {
      r.nodes.draft = { ...r.nodes.draft, status: 'AWAITING_HUMAN_MERGE' };
    });
    expect(codesOf(raw, 'output-only')).toContain('FREE_STATUS_DENIED');
  });

  it('passes the words that carry no meaning to a reader (positive control)', () => {
    expect(codesOf(stamped('VALIDATING_CONTEXT', 'pre'))).toEqual([]);
    expect(codesOf(stamped('PLANNING', 'pre'))).toEqual([]);
    expect(codesOf(stamped('PLANNING', 'post'))).toEqual([]);
  });
});
