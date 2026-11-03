/**
 * What a pull request title looks like, and the pure pieces that build and check one: the formats
 * an operator may choose, the Conventional Commits types, and the formatter that turns a type and
 * a summary into a title that always passes the grammar. Resolution (which format applies to a
 * repository) and the model call that picks a type live in the worker.
 */

/** `template` renders a free-form template; `conventional` renders `type: summary`. */
export const PR_TITLE_FORMATS = ['template', 'conventional'] as const;
export type PrTitleFormat = (typeof PR_TITLE_FORMATS)[number];

/** The Conventional Commits types a title may carry. */
export const CONVENTIONAL_COMMIT_TYPES = [
  'feat',
  'fix',
  'refactor',
  'perf',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
  'style',
] as const;
export type ConventionalCommitType = (typeof CONVENTIONAL_COMMIT_TYPES)[number];

/** The type used when nothing chose one, or the one chosen is not a Conventional Commits type. */
export const FALLBACK_CONVENTIONAL_TYPE: ConventionalCommitType = 'chore';

/** Longest conventional title: the subject-line limit the repository's own convention sets. */
export const CONVENTIONAL_TITLE_MAX_LENGTH = 72;

/** A title that is already `type: description` (a scope or `!` is tolerated, never produced). */
const CONVENTIONAL_TITLE_RE = new RegExp(
  `^(?:${CONVENTIONAL_COMMIT_TYPES.join('|')})(?:\\([a-z0-9._/-]+\\))?!?: \\S`
);

export function isConventionalCommitType(value: unknown): value is ConventionalCommitType {
  return (
    typeof value === 'string' && (CONVENTIONAL_COMMIT_TYPES as readonly string[]).includes(value)
  );
}

export function isPrTitleFormat(value: unknown): value is PrTitleFormat {
  return typeof value === 'string' && (PR_TITLE_FORMATS as readonly string[]).includes(value);
}

/** Whether `title` satisfies the Conventional Commits subject grammar and the length cap. */
export function isConventionalTitle(title: string): boolean {
  return (
    title.length <= CONVENTIONAL_TITLE_MAX_LENGTH &&
    !/[\r\n]/.test(title) &&
    CONVENTIONAL_TITLE_RE.test(title)
  );
}

/**
 * One line, no leading `type:` the model repeated, no trailing full stop, first letter lower-cased
 * unless the word is an acronym or identifier (a second capital, or a digit, in the first word).
 */
function tidySummary(summary: string, type: ConventionalCommitType): string {
  let text = summary.replace(/\s+/g, ' ').trim();
  text = text.replace(new RegExp(`^${type}(\\([^)]*\\))?!?:\\s*`, 'i'), '');
  text = text.replace(/[.。]+$/, '').trim();
  const firstWord = text.split(' ')[0] ?? '';
  if (text !== '' && !/[A-Z0-9_]/.test(firstWord.slice(1))) {
    text = text.charAt(0).toLowerCase() + text.slice(1);
  }
  return text;
}

/** Cut at a word boundary where one is near the end, by code point so no pair is split. */
function truncate(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) {
    return text;
  }
  const cut = points.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return (space > max / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/**
 * `type: summary`, always valid. An unknown type becomes {@link FALLBACK_CONVENTIONAL_TYPE}; a
 * summary that is empty after tidying becomes `fallbackSummary`; the whole is held to
 * {@link CONVENTIONAL_TITLE_MAX_LENGTH}. Repairs instead of refusing, so a run is never failed over
 * its title.
 */
export function formatConventionalTitle(input: {
  type: unknown;
  summary: string;
  fallbackSummary: string;
}): string {
  const type = isConventionalCommitType(input.type) ? input.type : FALLBACK_CONVENTIONAL_TYPE;
  const prefix = `${type}: `;
  const room = CONVENTIONAL_TITLE_MAX_LENGTH - prefix.length;
  const summary =
    truncate(tidySummary(input.summary, type), room) ||
    truncate(tidySummary(input.fallbackSummary, type), room) ||
    'update';
  return `${prefix}${summary}`;
}
