import type { BriefFinding } from '@auto-swe/shared/lib/prEvaluation';
import { describe, expect, it, vi } from 'vitest';
import {
  findingCommentBody,
  findingKey,
  MAX_INLINE_FINDINGS,
  postFindingComments,
} from './briefFindings.js';
import type { RepoRef } from './scm/types.js';

const HEAD = 'a'.repeat(40);
const REPO = { organizationName: 'acme', repoName: 'widgets' } as unknown as RepoRef;

const finding = (over: Partial<BriefFinding> = {}): BriefFinding => ({
  category: 'logic',
  description: 'the guard is inverted',
  file: 'src/a.ts',
  line: 12,
  reviewer: 'DOMAIN_LOGIC',
  severity: 'CRITICAL',
  suggestedFix: 'flip the condition',
  ...over,
});

function fakeScm(over: Record<string, unknown> = {}) {
  return {
    createReview: vi.fn(async () => ({ htmlUrl: 'https://host/r/1', ok: true as const })),
    getPullRequest: vi.fn(async () => ({ headSha: HEAD })),
    listReviewThreads: vi.fn(async () => []),
    ...over,
  };
}
const post = (findings: BriefFinding[], scm = fakeScm()) =>
  postFindingComments({
    connectionId: 'conn-1',
    findings,
    headSha: HEAD,
    prNumber: 7,
    repo: REPO,
    scm: scm as never,
  });

describe('postFindingComments', () => {
  it('posts the anchored findings in one review on the evaluated head', async () => {
    const scm = fakeScm();
    const result = await post([finding(), finding({ category: 'sec', line: null })], scm);
    expect(result).toEqual({ posted: 1 });
    expect(scm.createReview).toHaveBeenCalledTimes(1);
    const [, number, review] = scm.createReview.mock.calls[0] as unknown as [
      unknown,
      number,
      { body: string; comments: { body: string; line: number; path: string }[]; commitId: string },
    ];
    expect(number).toBe(7);
    expect(review.commitId).toBe(HEAD);
    expect(review.body).toContain('<!-- auto-swe:review-findings -->');
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]).toMatchObject({ line: 12, path: 'src/a.ts' });
    expect(review.comments[0]?.body).toContain(
      `<!-- auto-swe:finding ${findingKey(finding())} -->`
    );
  });

  it('posts nothing for a finding with no line in the diff, and asks the host nothing', async () => {
    const scm = fakeScm();
    expect(await post([finding({ line: null })], scm)).toEqual({
      posted: 0,
      reason: 'no anchored finding',
    });
    expect(scm.listReviewThreads).not.toHaveBeenCalled();
    expect(scm.createReview).not.toHaveBeenCalled();
  });

  it('skips a finding whose marker is already in a thread, so a retry never repeats it', async () => {
    const posted = finding();
    const scm = fakeScm({
      listReviewThreads: vi.fn(async () => [
        { comments: [{ body: findingCommentBody(posted) }], threadId: 't1' },
      ]),
    });
    expect(await post([posted], scm)).toEqual({ posted: 0, reason: 'already posted' });
    const other = finding({ category: 'perf' });
    await post([posted, other], scm);
    const [, , review] = scm.createReview.mock.calls[0] as unknown as [
      unknown,
      number,
      { comments: unknown[] },
    ];
    expect(review.comments).toHaveLength(1);
  });

  it('posts nothing when the head moved after the evaluation read it', async () => {
    const scm = fakeScm({ getPullRequest: vi.fn(async () => ({ headSha: 'b'.repeat(40) })) });
    expect(await post([finding()], scm)).toEqual({ posted: 0, reason: 'head moved' });
    expect(scm.createReview).not.toHaveBeenCalled();
  });

  it('caps the review at ten comments', async () => {
    const scm = fakeScm();
    const many = Array.from({ length: 14 }, (_, i) => finding({ category: `c${i}`, line: i + 1 }));
    expect(await post(many, scm)).toEqual({ posted: MAX_INLINE_FINDINGS });
  });

  it('never throws: a refusal, or any failure, is reported and the brief stands', async () => {
    const refused = fakeScm({
      createReview: vi.fn(async () => ({ ok: false, reason: 'rejected' })),
    });
    expect(await post([finding()], refused)).toEqual({ posted: 0, reason: 'refused' });
    const broken = fakeScm({
      listReviewThreads: vi.fn(async () => {
        throw new Error('host unreachable');
      }),
    });
    expect(await post([finding()], broken)).toEqual({ posted: 0, reason: 'error' });
  });
});

describe('findingCommentBody', () => {
  it('escapes model text onto one line and never offers a suggestion block', () => {
    const body = findingCommentBody(
      finding({
        category: '<b>x</b>',
        description: 'ping @everyone see #123\n# Heading <script>alert(1)</script>',
        suggestedFix: '```suggestion\nrm -rf /\n```',
      })
    );
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('<b>');
    expect(body).not.toContain('@everyone');
    expect(body).not.toContain('\n# Heading');
    expect(body).not.toContain('```suggestion');
    expect(body).not.toContain('see #123');
  });

  it('can never read as the feedback command', () => {
    const body = findingCommentBody(
      finding({ description: 'run /auto-swe fix now', suggestedFix: '/AUTO-SWE fix' })
    );
    expect(body).not.toMatch(/\/auto-swe\b/i);
  });

  it('keeps its marker last and the same for the same finding', () => {
    const a = findingCommentBody(finding());
    expect(a.endsWith(`<!-- auto-swe:finding ${findingKey(finding())} -->`)).toBe(true);
    expect(findingKey(finding())).toBe(findingKey(finding({ description: 'worded differently' })));
    expect(findingKey(finding())).not.toBe(findingKey(finding({ line: 13 })));
  });
});
