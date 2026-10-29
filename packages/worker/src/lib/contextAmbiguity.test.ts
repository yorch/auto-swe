import { describe, expect, it } from 'vitest';
import {
  assessSuccessCriteria,
  MAX_AMBIGUITIES,
  MAX_AMBIGUITY_CHARS,
  NO_CRITERIA_REASON,
  NO_REASON_GIVEN,
  splitSuccessCriteria,
} from './contextAmbiguity.js';

describe('assessSuccessCriteria', () => {
  it('is not actionable when every criterion is an ambiguity, and lists the reasons', () => {
    expect(
      assessSuccessCriteria(['AMBIGUOUS: the request is only a Jira URL', 'AMBIGUOUS:  no repo'])
    ).toEqual({
      actionable: false,
      ambiguities: ['the request is only a Jira URL', 'no repo'],
    });
  });

  it('is actionable when at least one criterion is verifiable', () => {
    expect(
      assessSuccessCriteria(['GET /health returns 200', 'AMBIGUOUS: no pagination limit'])
    ).toEqual({ actionable: true, ambiguities: ['no pagination limit'] });
  });

  describe('an empty list', () => {
    it('from a successful extraction is not actionable: nothing verifiable was found', () => {
      expect(assessSuccessCriteria([])).toEqual({
        actionable: false,
        ambiguities: [NO_CRITERIA_REASON],
      });
    });

    it('from a degraded extraction is not a verdict: the run goes on', () => {
      expect(assessSuccessCriteria([], { degraded: true })).toEqual({
        actionable: true,
        ambiguities: [],
      });
    });
  });

  it('matches the marker at the start only, tolerating case and surrounding space', () => {
    expect(assessSuccessCriteria(['  ambiguous : unclear']).actionable).toBe(false);
    expect(assessSuccessCriteria(['Resolve the AMBIGUOUS: label']).actionable).toBe(true);
    expect(assessSuccessCriteria(['Add a column. AMBIGUOUS: which table']).actionable).toBe(true);
  });

  it.each([
    ['backticks', '`AMBIGUOUS: unclear`'],
    ['bold with the colon inside', '**AMBIGUOUS:** unclear'],
    ['bold with the colon outside', '**AMBIGUOUS**: unclear'],
    ['underscores', '__AMBIGUOUS:__ unclear'],
    ['a dash bullet', '- AMBIGUOUS: unclear'],
    ['a star bullet', '* AMBIGUOUS: unclear'],
    ['a numbered item', '1. AMBIGUOUS: unclear'],
    ['a numbered item with a paren', '2) AMBIGUOUS: unclear'],
    ['an em dash', 'AMBIGUOUS — unclear'],
    ['a spaced hyphen', 'AMBIGUOUS - unclear'],
  ])('reads a marker written with %s', (_name, entry) => {
    expect(assessSuccessCriteria([entry])).toEqual({
      actionable: false,
      ambiguities: ['unclear'],
    });
  });

  describe('the Clarify: alias', () => {
    it.each([
      ['plain', 'Clarify: does the endpoint require authentication?'],
      ['lower case', 'clarify: does the endpoint require authentication?'],
      ['backticks', '`Clarify: does the endpoint require authentication?`'],
      ['bold', '**Clarify:** does the endpoint require authentication?'],
      ['a bullet', '- Clarify: does the endpoint require authentication?'],
      ['a numbered item', '1. Clarify: does the endpoint require authentication?'],
      ['an em dash', 'Clarify — does the endpoint require authentication?'],
      ['trailing whitespace', 'Clarify: does the endpoint require authentication?  '],
      ['a closing quote', 'Clarify: "does the endpoint require authentication?"'],
    ])('reads a question as an ambiguity, written with %s', (_name, entry) => {
      const result = assessSuccessCriteria([entry]);
      expect(result.actionable).toBe(false);
      expect(result.ambiguities[0]).toMatch(/^"?does the endpoint require authentication\?"?$/);
    });

    it('stays actionable beside a concrete criterion, and keeps the reason without the alias', () => {
      expect(assessSuccessCriteria(['GET /health returns 200', 'Clarify: which auth?'])).toEqual({
        actionable: true,
        ambiguities: ['which auth?'],
      });
    });

    it.each([
      'Clarify: the error message when X is empty',
      'Clarify - the endpoint returns 404',
      'Clarify : copy',
      'Clarify the error message wording',
      'Add a column. Clarify: which table?',
      'Clarifying text is shown?',
      'Clarify-looking input is rejected?',
    ])('reads %j as a concrete criterion: the alias needs a question', (entry) => {
      expect(assessSuccessCriteria([entry]).actionable).toBe(true);
    });

    it('keeps AMBIGUOUS unconditional: no question mark needed', () => {
      expect(assessSuccessCriteria(['AMBIGUOUS: the table is not named']).actionable).toBe(false);
    });
  });

  it('does not read a word that merely starts like the marker', () => {
    expect(assessSuccessCriteria(['AMBIGUOUS-looking input is rejected']).actionable).toBe(true);
  });

  describe('bounds on what is copied into the run result', () => {
    it('replaces an empty reason with a fixed placeholder', () => {
      expect(assessSuccessCriteria(['AMBIGUOUS:', 'AMBIGUOUS:   ']).ambiguities).toEqual([
        NO_REASON_GIVEN,
        NO_REASON_GIVEN,
      ]);
    });

    it('trims a long reason to the cap with an ellipsis', () => {
      const [reason] = assessSuccessCriteria([`AMBIGUOUS: ${'x'.repeat(2000)}`]).ambiguities;
      expect(reason).toHaveLength(MAX_AMBIGUITY_CHARS);
      expect(reason?.endsWith('…')).toBe(true);
    });

    it('keeps a reason of exactly the cap whole', () => {
      const exact = 'y'.repeat(MAX_AMBIGUITY_CHARS);
      expect(assessSuccessCriteria([`AMBIGUOUS: ${exact}`]).ambiguities).toEqual([exact]);
    });

    it('lists at most the cap, but still judges every criterion', () => {
      const many = Array.from({ length: MAX_AMBIGUITIES + 5 }, (_, i) => `AMBIGUOUS: gap ${i}`);
      const out = assessSuccessCriteria(many);
      expect(out.actionable).toBe(false);
      expect(out.ambiguities).toHaveLength(MAX_AMBIGUITIES);
      expect(out.ambiguities[0]).toBe('gap 0');
      expect(assessSuccessCriteria([...many, 'a real criterion']).actionable).toBe(true);
    });
  });
});

describe('splitSuccessCriteria', () => {
  it('separates the concrete criteria from the ambiguities, marker removed, in order', () => {
    expect(
      splitSuccessCriteria([
        'GET /health returns 200',
        'AMBIGUOUS: no auth policy',
        'Clarify: which table?',
        'POST /x returns 201',
      ])
    ).toEqual({
      ambiguities: ['no auth policy', 'which table?'],
      concrete: ['GET /health returns 200', 'POST /x returns 201'],
    });
  });

  it('returns nothing for an empty list', () => {
    expect(splitSuccessCriteria([])).toEqual({ ambiguities: [], concrete: [] });
  });

  it('bounds the ambiguities like the assessment does', () => {
    const many = Array.from({ length: MAX_AMBIGUITIES + 3 }, (_, i) => `AMBIGUOUS: q${i}`);
    expect(splitSuccessCriteria(many).ambiguities).toHaveLength(MAX_AMBIGUITIES);
  });
});

describe('blank entries', () => {
  it('are not concrete criteria', () => {
    expect(splitSuccessCriteria(['   ', '', 'AMBIGUOUS: what'])).toEqual({
      ambiguities: ['what'],
      concrete: [],
    });
    expect(assessSuccessCriteria(['   ', 'AMBIGUOUS: what']).actionable).toBe(false);
  });

  it('make an extraction of only blanks behave like no criteria', () => {
    expect(assessSuccessCriteria(['', '  '])).toEqual({
      actionable: false,
      ambiguities: [NO_CRITERIA_REASON],
    });
  });
});
