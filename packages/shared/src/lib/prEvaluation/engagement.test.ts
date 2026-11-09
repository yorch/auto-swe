import { describe, expect, it } from 'vitest';
import {
  classifyCommentPath,
  type EngagementRow,
  type FirstViewRow,
  isPlatformText,
  summarizeBriefEngagement,
  summarizeFirstViews,
} from './engagement.js';

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 1, 12, minutes));
const row = (over: Partial<EngagementRow> = {}): EngagementRow => ({
  changesRequestedCount: 0,
  commentsElsewhere: 0,
  commentsOnFlagged: 0,
  commentsOnSkimmed: 0,
  createdAt: at(0),
  firstHumanReviewAt: null,
  ...over,
});

describe('isPlatformText', () => {
  it('recognises the platform marker anywhere in the text', () => {
    expect(isPlatformText('<!-- auto-swe:pr-evaluation -->\nbrief')).toBe(true);
    expect(isPlatformText('hi\n<!-- auto-swe:finding abc -->')).toBe(true);
    expect(isPlatformText('looks good')).toBe(false);
    expect(isPlatformText(null)).toBe(false);
    expect(isPlatformText(undefined)).toBe(false);
  });
});

describe('classifyCommentPath', () => {
  const brief = {
    path: [
      { flagged: true, path: 'db/migrations/1.sql' },
      { flagged: false, path: 'src/a.ts' },
    ],
    skim: [{ path: 'src/old.ts' }],
  };
  it('places a comment against the brief it was stored with', () => {
    expect(classifyCommentPath('db/migrations/1.sql', brief)).toBe('flagged');
    expect(classifyCommentPath('src/old.ts', brief)).toBe('skimmed');
    expect(classifyCommentPath('src/a.ts', brief)).toBe('elsewhere');
    expect(classifyCommentPath('src/unknown.ts', brief)).toBe('elsewhere');
  });
  it('places everything elsewhere for a brief of another shape', () => {
    expect(classifyCommentPath('src/a.ts', null)).toBe('elsewhere');
    expect(classifyCommentPath('src/a.ts', 'text')).toBe('elsewhere');
    expect(classifyCommentPath('src/a.ts', { focus: [{ path: 'src/a.ts' }] })).toBe('elsewhere');
    expect(classifyCommentPath('src/a.ts', { path: 'nope', skim: 7 })).toBe('elsewhere');
  });
});

describe('summarizeBriefEngagement', () => {
  it('is empty and null-safe with no rows', () => {
    expect(summarizeBriefEngagement([])).toEqual({
      changeRequestRate: null,
      comments: { elsewhere: 0, flagged: 0, flaggedShare: null, skimmed: 0, skimmedShare: null },
      evaluations: 0,
      medianMinutesToFirstReview: null,
      reviewed: 0,
    });
  });

  it('takes the median wait, the change-request rate and the comment shares', () => {
    const summary = summarizeBriefEngagement([
      row({ commentsOnFlagged: 3, commentsOnSkimmed: 1, firstHumanReviewAt: at(10) }),
      row({ changesRequestedCount: 1, commentsElsewhere: 4, firstHumanReviewAt: at(30) }),
      row({ firstHumanReviewAt: at(20) }),
      row(),
    ]);
    expect(summary.evaluations).toBe(4);
    expect(summary.reviewed).toBe(3);
    expect(summary.medianMinutesToFirstReview).toBe(20);
    expect(summary.changeRequestRate).toBe(0.333);
    expect(summary.comments).toEqual({
      elsewhere: 4,
      flagged: 3,
      flaggedShare: 0.375,
      skimmed: 1,
      skimmedShare: 0.125,
    });
  });

  it('averages the middle two waits for an even count and never reports a negative wait', () => {
    const summary = summarizeBriefEngagement([
      row({ firstHumanReviewAt: at(10) }),
      row({ firstHumanReviewAt: at(20) }),
      row({ firstHumanReviewAt: at(-5) }),
      row({ firstHumanReviewAt: at(40) }),
    ]);
    expect(summary.medianMinutesToFirstReview).toBe(15);
  });
});

describe('summarizeFirstViews', () => {
  const visit = (over: Partial<FirstViewRow> = {}): FirstViewRow => ({
    firstVisitedAt: at(10),
    openedAt: at(0),
    pullRequestId: 'pr-1',
    ...over,
  });

  it('has nothing to say with no visits', () => {
    expect(summarizeFirstViews([])).toEqual({
      medianMinutesToFirstView: null,
      pullRequestsViewed: 0,
    });
  });

  it('measures from the pull request opening to the earliest visit by anyone', () => {
    const summary = summarizeFirstViews([
      visit({ firstVisitedAt: at(30) }),
      visit({ firstVisitedAt: at(12) }),
      visit({ firstVisitedAt: at(45) }),
    ]);
    expect(summary).toEqual({ medianMinutesToFirstView: 12, pullRequestsViewed: 1 });
  });

  it('counts a pull request once however many people opened it', () => {
    const summary = summarizeFirstViews([
      visit({ pullRequestId: 'a' }),
      visit({ pullRequestId: 'a' }),
      visit({ openedAt: at(5), pullRequestId: 'b' }),
    ]);
    expect(summary.pullRequestsViewed).toBe(2);
  });

  it('takes the median across pull requests, averaging the middle two', () => {
    const summary = summarizeFirstViews([
      visit({ firstVisitedAt: at(10), pullRequestId: 'a' }),
      visit({ firstVisitedAt: at(20), pullRequestId: 'b' }),
      visit({ firstVisitedAt: at(60), pullRequestId: 'c' }),
      visit({ firstVisitedAt: at(90), pullRequestId: 'd' }),
    ]);
    expect(summary.medianMinutesToFirstView).toBe(40);
  });

  it('never reports a negative wait', () => {
    expect(summarizeFirstViews([visit({ firstVisitedAt: at(-3) })]).medianMinutesToFirstView).toBe(
      0
    );
  });
});
