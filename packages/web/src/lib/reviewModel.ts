import type {
  PullRequestCockpit,
  PullRequestCockpitFile,
  PullRequestCockpitFinding,
} from '@auto-swe/shared/types/api';

/** What the file rail shows: all, the ones to verify, the unread ones, or the proven-skimmable. */
export type FileFilter = 'all' | 'verify' | 'unviewed' | 'skim';

export function filterFiles(
  files: readonly PullRequestCockpitFile[],
  viewed: ReadonlySet<string>,
  filter: FileFilter
): PullRequestCockpitFile[] {
  switch (filter) {
    case 'verify':
      return files.filter((f) => f.flagged);
    case 'unviewed':
      return files.filter((f) => !viewed.has(f.path));
    case 'skim':
      return files.filter((f) => f.skim !== null);
    default:
      return [...files];
  }
}

/**
 * A file can be marked viewed only when it has a patch to match the mark against, so progress
 * counts those and not the binary or oversized files.
 */
export function viewedProgress(
  files: readonly PullRequestCockpitFile[],
  viewed: ReadonlySet<string>
): { done: number; total: number } {
  const reviewable = files.filter((f) => f.patchDigest !== null);
  return { done: reviewable.filter((f) => viewed.has(f.path)).length, total: reviewable.length };
}

/** The findings that sit on a line of this file's patch, by the line of the new side. */
export function findingsByLine(
  findings: readonly PullRequestCockpitFinding[],
  path: string
): Map<number, PullRequestCockpitFinding[]> {
  const byLine = new Map<number, PullRequestCockpitFinding[]>();
  for (const finding of findings) {
    if (finding.anchored && finding.line !== null && finding.file === path) {
      byLine.set(finding.line, [...(byLine.get(finding.line) ?? []), finding]);
    }
  }
  return byLine;
}

/** The findings with no line to sit on: shown together, ahead of the diff. */
export function unanchoredFindings(
  findings: readonly PullRequestCockpitFinding[]
): PullRequestCockpitFinding[] {
  return findings.filter((f) => !f.anchored || f.line === null);
}

/** The number of findings on each file, anchored or not. */
export function findingCounts(findings: readonly PullRequestCockpitFinding[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.file, (counts.get(finding.file) ?? 0) + 1);
  }
  return counts;
}

/** What one request to the viewed route says: the files, and whether they are now viewed. */
export type ViewedChange = {
  files: { path: string; patchDigest: string }[];
  viewed: boolean;
};

/** The viewed paths after `change`, in the order they were already in, new ones last. */
export function applyViewed(viewed: readonly string[], change: ViewedChange): string[] {
  const named = new Set(change.files.map((f) => f.path));
  if (!change.viewed) {
    return viewed.filter((path) => !named.has(path));
  }
  const kept = new Set(viewed);
  return [...viewed, ...[...named].filter((path) => !kept.has(path))];
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Why the files are missing, in words a reviewer can act on. */
export function filesUnavailableMessage(
  reason: Extract<PullRequestCockpit['files'], { type: 'unavailable' }>['reason']
): string {
  switch (reason) {
    case 'host-not-approved':
      return 'This repository is on a host the platform is not set up to read, so the changed files cannot be shown here.';
    case 'no-credential':
      return 'The platform has no credential for this repository, so the changed files cannot be shown here.';
    case 'not-found':
      return 'The host no longer has this pull request, so its files cannot be shown.';
    case 'rate-limited':
      return 'The host is limiting requests right now. Reload in a minute.';
    default:
      return 'The host could not be read, so the changed files cannot be shown.';
  }
}
