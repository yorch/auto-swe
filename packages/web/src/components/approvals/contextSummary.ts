import { isUnifiedDiff, parseUnifiedDiff } from './diffParse';

/** The most characters of a plain-text context the collapsed card shows. */
const EXCERPT_CHARS = 200;

/**
 * One or two lines of what a step's context holds, for the collapsed card: a person choosing
 * which approval to open first needs the shape of the change, not only the step's title. A diff
 * is summarised by the files it touches and its added and removed lines; any other context shows
 * its first lines, cut to a short excerpt. Null when there is nothing to show.
 */
export function summarizeContext(context: string): string | null {
  const text = context.trim();
  if (!text) {
    return null;
  }
  if (isUnifiedDiff(text)) {
    const files = parseUnifiedDiff(text);
    if (files.length > 0) {
      const added = files.reduce((n, f) => n + f.added, 0);
      const removed = files.reduce((n, f) => n + f.removed, 0);
      const names = files.slice(0, 2).map((f) => f.name);
      const more = files.length - names.length;
      return `${files.length} ${files.length === 1 ? 'file' : 'files'} changed (+${added} −${removed}): ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
    }
  }
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(' · ');
  return lines.length > EXCERPT_CHARS ? `${lines.slice(0, EXCERPT_CHARS - 1)}…` : lines;
}

/** What the button that opens a pending step says, by the kind of answer it takes. */
export function respondLabel(kind: string): string {
  switch (kind) {
    case 'APPROVAL':
      return 'Review and decide';
    case 'DECISION':
      return 'Choose';
    case 'INPUT':
      return 'Fill in';
    case 'REVIEW':
      return 'Review';
    default:
      return 'Respond';
  }
}
