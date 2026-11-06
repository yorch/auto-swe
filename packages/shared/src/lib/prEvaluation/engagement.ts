/**
 * Whether reviewers act on the reviewer brief, in counts. A row of `PrEvaluation` carries when a
 * person first reviewed its head, how many reviews asked for changes, and where their inline
 * comments landed against the brief: on a file it flagged, on one it said was safe to skim, or
 * anywhere else. Nothing here names a person or keeps what they wrote.
 */

/** The marker every comment and review the platform writes carries, whoever posts it. */
export const AUTOMATION_MARKER = '<!-- auto-swe:';

/** True for text the platform itself wrote (the brief, a finding): never a reviewer's act. */
export function isPlatformText(body: string | null | undefined): boolean {
  return typeof body === 'string' && body.includes(AUTOMATION_MARKER);
}

export type CommentPlacement = 'flagged' | 'skimmed' | 'elsewhere';

type StoredBrief = {
  path?: { flagged?: unknown; path?: unknown }[];
  skim?: { path?: unknown }[];
};

/**
 * Where a comment on `path` landed against a stored brief. A brief stored in an older shape, or
 * one that names neither list, places every comment `elsewhere`: the counts then say less, not
 * something false.
 */
export function classifyCommentPath(path: string, brief: unknown): CommentPlacement {
  if (!brief || typeof brief !== 'object') {
    return 'elsewhere';
  }
  const { path: read, skim } = brief as StoredBrief;
  if (Array.isArray(read) && read.some((e) => e?.flagged === true && e.path === path)) {
    return 'flagged';
  }
  if (Array.isArray(skim) && skim.some((e) => e?.path === path)) {
    return 'skimmed';
  }
  return 'elsewhere';
}

export type EngagementRow = {
  changesRequestedCount: number;
  commentsElsewhere: number;
  commentsOnFlagged: number;
  commentsOnSkimmed: number;
  createdAt: Date;
  firstHumanReviewAt: Date | null;
};

export type BriefEngagementSummary = {
  /** Evaluations in the window. */
  evaluations: number;
  /** Of those, how many a person reviewed. */
  reviewed: number;
  /** Median minutes from the evaluation to the first review; null when none was reviewed. */
  medianMinutesToFirstReview: number | null;
  /** Share of reviewed evaluations with at least one review asking for changes. */
  changeRequestRate: number | null;
  comments: {
    elsewhere: number;
    flagged: number;
    /** Share of all inline comments that landed on a flagged file; null with no comments. */
    flaggedShare: number | null;
    skimmed: number;
    skimmedShare: number | null;
  };
};

const share = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 1000;

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return Math.round(value * 10) / 10;
}

/** One person's first visit to the review page of one pull request. */
export type FirstViewRow = { firstVisitedAt: Date; openedAt: Date; pullRequestId: string };

export type FirstViewSummary = {
  /** Pull requests in the window that someone opened on the review page. */
  pullRequestsViewed: number;
  /** Median minutes from a pull request opening to its first view there; null with none. */
  medianMinutesToFirstView: number | null;
};

/**
 * How long a pull request waits before anyone opens it on the review page: the earliest visit per
 * pull request, whoever made it. It says when a reviewer began, not that they reviewed.
 */
export function summarizeFirstViews(rows: readonly FirstViewRow[]): FirstViewSummary {
  const earliest = new Map<string, number>();
  const opened = new Map<string, number>();
  for (const row of rows) {
    const at = row.firstVisitedAt.getTime();
    const known = earliest.get(row.pullRequestId);
    if (known === undefined || at < known) {
      earliest.set(row.pullRequestId, at);
    }
    opened.set(row.pullRequestId, row.openedAt.getTime());
  }
  // A visit dated before the pull request opened reads as no wait, like a review does.
  const waits = [...earliest].map(([id, at]) =>
    Math.max(0, (at - (opened.get(id) as number)) / 60_000)
  );
  return { medianMinutesToFirstView: median(waits), pullRequestsViewed: earliest.size };
}

export function summarizeBriefEngagement(rows: readonly EngagementRow[]): BriefEngagementSummary {
  const reviewed = rows.filter((row) => row.firstHumanReviewAt !== null);
  // A review that landed before the evaluation's row was written reads as no wait at all.
  const waits = reviewed.map((row) =>
    Math.max(0, ((row.firstHumanReviewAt as Date).getTime() - row.createdAt.getTime()) / 60_000)
  );
  const flagged = rows.reduce((sum, row) => sum + row.commentsOnFlagged, 0);
  const skimmed = rows.reduce((sum, row) => sum + row.commentsOnSkimmed, 0);
  const elsewhere = rows.reduce((sum, row) => sum + row.commentsElsewhere, 0);
  const all = flagged + skimmed + elsewhere;
  return {
    changeRequestRate: share(
      reviewed.filter((row) => row.changesRequestedCount > 0).length,
      reviewed.length
    ),
    comments: {
      elsewhere,
      flagged,
      flaggedShare: share(flagged, all),
      skimmed,
      skimmedShare: share(skimmed, all),
    },
    evaluations: rows.length,
    medianMinutesToFirstReview: median(waits),
    reviewed: reviewed.length,
  };
}
