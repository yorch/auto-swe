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
});
