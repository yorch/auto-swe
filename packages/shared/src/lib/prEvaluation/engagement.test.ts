import { describe, expect, it } from 'vitest';
import {
  classifyCommentPath,
  type EngagementRow,
  isPlatformText,
  summarizeBriefEngagement,
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
