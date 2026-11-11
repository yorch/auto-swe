/**
 * Turning the pinned patch text into the text the scanners read.
 *
 * `git diff-tree --text` is what keeps a `-diff` / `binary` attribute from blanking a file, and it
 * has a price: a real binary (a 3 MiB `logo.png`) comes back as raw bytes, millions of characters
 * of junk that would go whole into the security gate, the reviewers and `CodeResult.diff` (a
 * Temporal payload with a ~2 MB limit). So a section of the patch that contains a NUL character is
 * replaced by a compact stand-in: its header (path, mode, blob shas) and the printable strings in
 * its added lines, which is what a secret embedded in a binary looks like to a scanner.
 *
 * Text sections stay whole. No truncation and no lockfile exclusion here: a secret can hide in a
 * file named like one, and a diff too large to read fails closed at the read instead.
 */
import { ApplicationFailure } from '@temporalio/activity';

/** A run of at least this many printable ASCII characters counts as a string. */
const MIN_STRING_LENGTH = 8;

/** The most string text one binary file may contribute; more than this fails closed. */
export const MAX_BINARY_STRINGS_CHARS = 64 * 1024;

const PRINTABLE_RUN = new RegExp(`[\\x20-\\x7e\\t]{${MIN_STRING_LENGTH},}`, 'g');

/** Splits a patch at each `diff --git` header line; a header cannot be forged by file content,
 * because every content line of a patch carries a `+`, `-` or space prefix. */
function splitSections(patch: string): string[] {
  const sections: string[] = [];
  let start = 0;
  const header = /^diff --git /gm;
  for (const match of patch.matchAll(header)) {
    if (match.index > start) {
      sections.push(patch.slice(start, match.index));
    }
    start = match.index;
  }
  sections.push(patch.slice(start));
  return sections.filter((s) => s.length > 0);
}

function sectionPath(section: string): string {
  const firstLine = section.slice(
    0,
    section.indexOf('\n') === -1 ? undefined : section.indexOf('\n')
  );
  return firstLine.replace(/^diff --git a\/.* b\//, '') || firstLine;
}

/** The printable strings of a section's added lines, deduplicated, in order of appearance. */
function addedStrings(body: string): string[] {
  const seen = new Set<string>();
  for (const line of body.split('\n')) {
    if (!line.startsWith('+')) {
      continue;
    }
    for (const found of line.slice(1).matchAll(PRINTABLE_RUN)) {
      seen.add(found[0]);
    }
  }
  return [...seen];
}

function standIn(section: string): string {
  const hunk = section.search(/^@@/m);
  const header = hunk === -1 ? section : section.slice(0, hunk);
  const body = hunk === -1 ? '' : section.slice(hunk);
  const path = sectionPath(section);
  const strings = addedStrings(body);
  const total = strings.reduce((sum, s) => sum + s.length + 1, 0);
  if (total > MAX_BINARY_STRINGS_CHARS) {
    throw ApplicationFailure.nonRetryable(
      `The binary file ${path} holds more than ${MAX_BINARY_STRINGS_CHARS} characters of printable ` +
        'strings, so it cannot be reduced to a stand-in for the security scan. Nothing further was run.',
      'SECURITY_GATE_UNAVAILABLE'
    );
  }
  return (
    `${header}Binary content of ${path} (${body.length} characters of patch text, ` +
    `${strings.length} printable strings of ${MIN_STRING_LENGTH}+ characters, listed as added lines):\n` +
    strings.map((s) => `+${s}\n`).join('')
  );
}

/**
 * The scanner input for a pinned patch: every section that contains a NUL replaced by its
 * stand-in, every other section untouched. Throws `SECURITY_GATE_UNAVAILABLE` (non-retryable)
 * naming the file when a binary's strings exceed {@link MAX_BINARY_STRINGS_CHARS}.
 */
export function standInBinarySections(patch: string): string {
  if (!patch.includes('\0')) {
    return patch;
  }
  return splitSections(patch)
    .map((section) => (section.includes('\0') ? standIn(section) : section))
    .join('');
}
