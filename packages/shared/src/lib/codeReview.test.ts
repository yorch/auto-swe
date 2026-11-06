import { describe, expect, it } from 'vitest';
import {
  REVIEW_ERROR_CODES,
  ReviewOfSchema,
  ReviewPresetAttachmentSchema,
  ReviewPresetCreateSchema,
  ReviewPresetUpdateSchema,
  ReviewRunPayloadSchema,
  type ReviewSourceFacts,
  resolveReviewOf,
  reviewWorkflowId,
} from './codeReview.js';

const ID = '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d';
const SHA = 'a'.repeat(40);
const codeResult = { baseBranch: 'main', branch: 'auto/change', headSha: SHA };
const facts: ReviewSourceFacts = {
  codeResult,
  deliver: 'none',
  isAgentRun: true,
  pullRequest: { prNumber: 42, status: 'OPEN' },
  status: 'SUCCESS',
  storedDiff: '+change',
};

describe('resolveReviewOf', () => {
  it('prefers an open PR and leaves branch facts to the host read', () => {
    expect(resolveReviewOf(facts)).toEqual({ ok: true, reviewOf: { mode: 'pr', prNumber: 42 } });
  });

  it.each(['MERGED', 'CLOSED'])('falls back to the branch for a %s PR', (status) => {
    expect(resolveReviewOf({ ...facts, pullRequest: { prNumber: 42, status } })).toEqual({
      ok: true,
      reviewOf: { mode: 'branch', ...codeResult },
    });
  });

  it('accepts legacy branch facts without a base branch', () => {
    expect(
      resolveReviewOf({ codeResult: { branch: 'topic', headSha: SHA }, status: 'FAILED' })
    ).toEqual({ ok: true, reviewOf: { branch: 'topic', headSha: SHA, mode: 'branch' } });
  });

  it('selects branch identity from a full CodeResult without copying its diff', () => {
    const result = { ...codeResult, diff: '+change', filesChanged: [] };
    expect(resolveReviewOf({ codeResult: result, status: 'SUCCESS' })).toEqual({
      ok: true,
      reviewOf: { mode: 'branch', ...codeResult },
    });
  });

  it('falls back from an incomplete PR to a valid branch', () => {
    expect(resolveReviewOf({ ...facts, pullRequest: { prNumber: null, status: 'OPEN' } })).toEqual({
      ok: true,
      reviewOf: { mode: 'branch', ...codeResult },
    });
  });

  it('selects stored diffs only for agent runs delivering nothing', () => {
    expect(resolveReviewOf({ ...facts, codeResult: null, pullRequest: null })).toEqual({
      ok: true,
      reviewOf: { mode: 'stored' },
    });
    for (const change of [{ isAgentRun: false }, { deliver: 'branch' }, { storedDiff: '  ' }]) {
      expect(resolveReviewOf({ ...facts, codeResult: null, pullRequest: null, ...change })).toEqual(
        { code: REVIEW_ERROR_CODES.NOTHING_TO_REVIEW, ok: false }
      );
    }
  });

  it.each(['SUCCESS', 'FAILED', 'TIMED_OUT', 'SKIPPED', 'CANCELLED'])(
    'allows finished status %s',
    (status) => {
      expect(resolveReviewOf({ ...facts, status }).ok).toBe(true);
    }
  );

  it.each(['RUNNING', 'PENDING', '', 'unknown'])('rejects unfinished status %s', (status) => {
    expect(resolveReviewOf({ ...facts, status })).toEqual({
      code: REVIEW_ERROR_CODES.SOURCE_NOT_FINISHED,
      ok: false,
    });
  });

  it('refuses reviews of reviews', () => {
    expect(resolveReviewOf({ ...facts, templateKind: 'review' })).toEqual({
      code: REVIEW_ERROR_CODES.SOURCE_IS_REVIEW,
      ok: false,
    });
    expect(resolveReviewOf({ ...facts, reviewOfRunId: ID })).toEqual({
      code: REVIEW_ERROR_CODES.SOURCE_IS_REVIEW,
      ok: false,
    });
  });

  it('rejects missing, unsafe or incomplete change facts', () => {
    for (const code of [
      undefined,
      {},
      { branch: '../bad', headSha: SHA },
      { branch: 'topic', headSha: 'short' },
      { branch: 'topic' },
    ]) {
      expect(resolveReviewOf({ codeResult: code, status: 'SUCCESS' })).toEqual({
        code: REVIEW_ERROR_CODES.NOTHING_TO_REVIEW,
        ok: false,
      });
    }
  });
});

describe('review input schemas', () => {
  it.each([{ mode: 'pr', prNumber: 1 }, { mode: 'branch', ...codeResult }, { mode: 'stored' }])(
    'accepts a %j payload',
    (reviewOf) => {
      expect(
        ReviewRunPayloadSchema.parse({ connectionId: ID, reviewOf, sourceRunId: ID })
      ).toMatchObject({ onBlocking: 'report', reviewOf });
    }
  );

  it.each([
    {},
    { mode: 'other' },
    { mode: 'pr', prNumber: 0 },
    { branch: 'topic', mode: 'branch' },
    { diff: 'untrusted payload', mode: 'stored' },
  ])('rejects invalid review target %j', (value) => {
    expect(ReviewOfSchema.safeParse(value).success).toBe(false);
  });

  it('validates identifiers and rejects extra payload fields', () => {
    expect(ReviewRunPayloadSchema.safeParse({}).success).toBe(false);
    expect(
      ReviewRunPayloadSchema.safeParse({
        connectionId: 'bad',
        reviewOf: { mode: 'stored' },
        sourceRunId: ID,
      }).success
    ).toBe(false);
    expect(
      ReviewRunPayloadSchema.safeParse({
        connectionId: ID,
        diff: 'no',
        reviewOf: { mode: 'stored' },
        sourceRunId: ID,
      }).success
    ).toBe(false);
  });

  it('defaults and trims preset creation without defaulting omitted updates', () => {
    expect(ReviewPresetCreateSchema.parse({ name: ' Security ', templateId: ID })).toEqual({
      description: '',
      enabled: true,
      name: 'Security',
      onBlocking: 'report',
      templateId: ID,
    });
    expect(ReviewPresetUpdateSchema.parse({ enabled: false })).toEqual({ enabled: false });
    expect(ReviewPresetUpdateSchema.parse({ systemPrompt: null })).toEqual({ systemPrompt: null });
  });

  it('rejects empty, invalid and unknown preset fields', () => {
    expect(ReviewPresetCreateSchema.safeParse({}).success).toBe(false);
    expect(ReviewPresetCreateSchema.safeParse({ name: ' ', templateId: ID }).success).toBe(false);
    for (const value of [
      {},
      { enabled: undefined },
      { onBlocking: 'ignore' },
      { unknown: true },
      { templateId: 'bad' },
      { systemPrompt: 'a'.repeat(100_001) },
    ]) {
      expect(ReviewPresetUpdateSchema.safeParse(value).success).toBe(false);
    }
  });

  it('requires exactly one attachment target', () => {
    for (const target of [{ templateId: ID }, { connectionId: ID }]) {
      expect(ReviewPresetAttachmentSchema.safeParse({ presetId: ID, ...target }).success).toBe(
        true
      );
    }
    for (const value of [
      {},
      { presetId: ID },
      { connectionId: ID, presetId: ID, templateId: ID },
      { connectionId: 'bad', presetId: ID },
    ]) {
      expect(ReviewPresetAttachmentSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('reviewWorkflowId', () => {
  it('uses normalized repo and caller-supplied random hex prefixes', () => {
    expect(reviewWorkflowId(ID, 'ABCDEF123456')).toBe('review-1a2b3c4d-abcdef12');
  });

  it.each([
    ['bad', 'abcdef12'],
    [ID, 'short'],
    [ID, ''],
    [ID, 'not-hex!'],
  ])('rejects malformed components %s %s', (repo, hex) => {
    expect(() => reviewWorkflowId(repo, hex)).toThrow();
  });
});
