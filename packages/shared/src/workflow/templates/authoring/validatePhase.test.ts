import { describe, expect, it } from 'vitest';
import { expectWellFormed } from './testUtil.js';
import { validatePhase } from './validatePhase.js';

describe('validatePhase', () => {
  it('default: setValidating -> validate -> setSuccessCriteria -> next', () => {
    const nodes = validatePhase({ next: 'setImplementing' });
    expect(Object.keys(nodes).sort()).toEqual(['setSuccessCriteria', 'setValidating', 'validate']);
    expect(nodes.setValidating).toMatchObject({
      config: { status: 'VALIDATING_CONTEXT' },
      next: 'validate',
    });
    expect(nodes.validate).toMatchObject({
      next: 'setSuccessCriteria',
      onError: 'continue',
      step: 'validateContext',
    });
    expect(nodes.setSuccessCriteria).toMatchObject({
      next: 'setImplementing',
      values: {
        'context.successCriteria': {
          default: [],
          from: 'nodes.validate.output.successCriteria',
        },
      },
    });
    expectWellFormed(nodes, 'setValidating', ['setImplementing']);
  });

  it('without success criteria, validate goes straight to `next`', () => {
    const nodes = validatePhase({ next: 'setImplementing', successCriteria: false });
    expect(Object.keys(nodes).sort()).toEqual(['setValidating', 'validate']);
    expect(nodes.validate).toMatchObject({ next: 'setImplementing' });
    expectWellFormed(nodes, 'setValidating', ['setImplementing']);
  });

  it('without the stamp, the phase starts at validate', () => {
    const nodes = validatePhase({ next: 'setImplementing', stamp: false });
    expect(nodes.setValidating).toBeUndefined();
    expectWellFormed(nodes, 'validate', ['setImplementing']);
  });

  it('can name the success-criteria node differently', () => {
    const nodes = validatePhase({
      next: 'setImplementing',
      stamp: false,
      successCriteriaId: 'successCriteria',
    });
    expect(nodes.validate).toMatchObject({ next: 'successCriteria' });
    expect(nodes.successCriteria).toBeDefined();
    expect(nodes.setSuccessCriteria).toBeUndefined();
  });

  it('keeps validate non-blocking: its failure is a finding, not a stop', () => {
    expect(validatePhase({ next: 'x' }).validate).toMatchObject({ onError: 'continue' });
  });

  describe('with ticket context', () => {
    it('gathers the ticket between the stamp and validate, and hands it to validate', () => {
      const nodes = validatePhase({ next: 'setImplementing', ticketContext: true });
      expect(Object.keys(nodes).sort()).toEqual([
        'gatherTicket',
        'setSuccessCriteria',
        'setTicket',
        'setValidating',
        'validate',
      ]);
      expect(nodes.setValidating).toMatchObject({ next: 'gatherTicket' });
      expect(nodes.gatherTicket).toMatchObject({
        next: 'setTicket',
        onError: 'continue',
        step: 'gatherTicketContext',
        type: 'step',
      });
      expect(nodes.setTicket).toMatchObject({
        next: 'validate',
        type: 'set',
        values: { 'context.ticket': { default: '', from: 'nodes.gatherTicket.output.text' } },
      });
      expect(nodes.validate).toMatchObject({
        inputs: { ticket: { from: 'context.ticket' } },
        step: 'validateContext',
      });
      expectWellFormed(nodes, 'setValidating', ['setImplementing']);
    });

    it('starts at the gatherer when there is no stamp', () => {
      const nodes = validatePhase({ next: 'setImplementing', stamp: false, ticketContext: true });
      expect(nodes.setValidating).toBeUndefined();
      expectWellFormed(nodes, 'gatherTicket', ['setImplementing']);
    });

    it('keeps the gatherer non-blocking: a failed gather is no ticket, not a stopped run', () => {
      expect(validatePhase({ next: 'x', ticketContext: true }).gatherTicket).toMatchObject({
        onError: 'continue',
      });
    });

    it('is off by default: no extra nodes and no input on validate', () => {
      const nodes = validatePhase({ next: 'setImplementing' });
      expect(nodes.gatherTicket).toBeUndefined();
      expect(nodes.setTicket).toBeUndefined();
      expect(nodes.validate).not.toHaveProperty('inputs');
    });
  });

  describe('stopping when the request is not actionable', () => {
    const stop = { next: 'setImplementing', stopIfNotActionable: true } as const;

    it("checks validate's verdict before the criteria are kept, and ends the run when it is negative", () => {
      const nodes = validatePhase(stop);
      expect(nodes.validate).toMatchObject({ next: 'checkActionable' });
      expect(nodes.checkActionable).toMatchObject({
        expr: 'nodes.validate.output.actionable == false',
        onFalse: 'setSuccessCriteria',
        onTrue: 'terminateNotActionable',
        type: 'cond',
      });
      expect(nodes.terminateNotActionable).toMatchObject({
        result: {
          ambiguities: { default: [], from: 'nodes.validate.output.ambiguities' },
          message: { literal: expect.stringContaining('not actionable') },
        },
        status: 'FAILED',
        type: 'terminate',
      });
      expectWellFormed(nodes, 'setValidating', ['setImplementing']);
    });

    it('carries why the ticket could not be read, when it gathers the ticket', () => {
      const nodes = validatePhase({ ...stop, ticketContext: true });
      expect(nodes.terminateNotActionable).toMatchObject({
        result: {
          ticketUnavailableReason: {
            default: '',
            from: 'nodes.gatherTicket.output.unavailableReason',
          },
        },
      });
    });

    it('has no such field when no ticket is gathered', () => {
      const nodes = validatePhase(stop);
      expect(nodes.terminateNotActionable).not.toHaveProperty('result.ticketUnavailableReason');
    });

    it('goes straight to `next` when there are no success criteria to keep', () => {
      const nodes = validatePhase({ ...stop, successCriteria: false });
      expect(nodes.checkActionable).toMatchObject({ onFalse: 'setImplementing' });
      expectWellFormed(nodes, 'setValidating', ['setImplementing']);
    });

    it('follows the gatherer when the ticket context is on', () => {
      const nodes = validatePhase({ ...stop, ticketContext: true });
      expect(nodes.setTicket).toMatchObject({ next: 'validate' });
      expectWellFormed(nodes, 'setValidating', ['setImplementing']);
    });

    it('is off by default: no extra nodes', () => {
      const nodes = validatePhase({ next: 'setImplementing' });
      expect(nodes.checkActionable).toBeUndefined();
      expect(nodes.terminateNotActionable).toBeUndefined();
    });
  });
});
