/**
 * Turning the pinned patch text into the text the scanners read.
 *
 * `git diff-tree --text` is what keeps a `-diff` / `binary` attribute from blanking a file, and it
 * has a price: a real binary (a 3 MiB `logo.png`) comes back as raw bytes, millions of characters
 * of junk that would go whole into the security gate, the reviewers and `CodeResult.diff` (a
 * Temporal payload with a ~2 MB limit). So a section for a file that is binary BY NAME
 * ({@link BINARY_EXTENSIONS}) and holds a NUL is replaced by a compact stand-in: its header (path,
 * mode, blob shas) and the printable strings in its added lines (ASCII, UTF-16LE and UTF-16BE
 * runs, the equivalent of `strings -a`, `-el` and `-eb`), which is what a secret embedded in a
 * binary looks like to a scanner.
 *
 * Whether a file is binary is decided by its NAME, not by whether it holds a NUL: a NUL is one byte
 * the author of the file chooses, and a source file that carries one would otherwise be demoted to
 * "binary" and reduced to its longer printable runs, hiding every short line. Every other section
 * keeps ALL its lines, with NUL and other control characters replaced by a visible marker, and a
 * NUL on an added line of such a file is announced by a {@link NUL_NOTICE_PREFIX} line that the
 * security gate turns into a deterministic CRITICAL finding ({@link nulNoticePaths}).
 *
 * No truncation and no lockfile exclusion for text: a secret can hide in a file named like one,
 * and a diff too large to read fails closed at the read instead. A binary's strings are limited
 * for the model ({@link MAX_BINARY_STRINGS_CHARS}), but every extracted string is checked locally
 * for the shape of a credential and those are always kept ({@link isCredentialShaped}); only an
 * absurd amount of strings ({@link MAX_BINARY_STRINGS_ABSOLUTE}) fails closed.
 */
import { ApplicationFailure } from '@temporalio/activity';
import { SECURITY_RULES } from '../agents/preWriteSecurityCheck.js';
import { maskCredentialShapes } from '../lib/redactToken.js';

/** A run of at least this many printable characters counts as a string. */
const MIN_STRING_LENGTH = 8;

/** The most string text one binary file contributes to the scanner input before it is marked truncated. */
export const MAX_BINARY_STRINGS_CHARS = 64 * 1024;

/** More string text than this in one binary file fails closed: it cannot be shown or checked. */
export const MAX_BINARY_STRINGS_ABSOLUTE = 8 * 1024 * 1024;

/** The most characters of any one credential-shaped string kept past the truncation. */
const MAX_SHAPED_STRING_CHARS = 1024;

/** The most credential-shaped text kept past the truncation, in total. */
const MAX_SHAPED_TOTAL_CHARS = 64 * 1024;

/** The line that announces a NUL byte inside an added line of a file that is not binary by name. */
export const NUL_NOTICE_PREFIX = '[NUL byte in text file ';

/**
 * File extensions that are binary by name. A NUL inside one of these is expected; anywhere else it
 * is announced and the file is read in full.
 */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    '7z a apk avi avif bin bmp br bz2 cab class dat db deb dex dll dmg doc docx dylib eot exe flac ' +
    'gif gz heic ico img iso jar jpeg jpg lib lz lz4 m4a mkv mo mov mp3 mp4 node o obj odt ogg otf ' +
    'parquet pdf png ppt pptx pyc pyd rar rpm so sqlite sqlite3 tar tgz tif tiff ttf wasm wav webm ' +
    'webp whl woff woff2 xls xlsx xz zip zst'
  ).split(' ')
);

/** Whether `path` is binary by its extension (case-insensitive; the last dot of the last segment). */
export function isBinaryPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && BINARY_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

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

/** The added lines of a section, without their `+` prefix. */
function addedLines(body: string): string[] {
  const lines: string[] = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++ ')) {
      lines.push(line.slice(1));
    }
  }
  return lines;
}

const isPrintable = (code: number): boolean => (code >= 0x20 && code <= 0x7e) || code === 0x09;

/**
 * Runs of at least {@link MIN_STRING_LENGTH} printable characters in `line`: plain ASCII, or
 * UTF-16 where each character is a printable byte next to a NUL (`le`: the NUL follows,
 * `be`: it comes first). Hand-rolled rather than a regex, which overflows V8's stack on a
 * multi-megabyte run.
 */
function runsOf(line: string, mode: 'ascii' | 'le' | 'be', emit: (text: string) => void): void {
  const width = mode === 'ascii' ? 1 : 2;
  let text = '';
  const flush = () => {
    if (text.length >= MIN_STRING_LENGTH) {
      emit(text);
    }
    text = '';
  };
  for (let i = 0; i + width <= line.length; i += width) {
    const at = mode === 'be' ? i + 1 : i;
    const pad = mode === 'le' ? line.charCodeAt(i + 1) : mode === 'be' ? line.charCodeAt(i) : 0;
    if (pad === 0 && isPrintable(line.charCodeAt(at))) {
      text += line[at];
    } else {
      flush();
    }
  }
  flush();
}

/**
 * The printable strings of a section's added lines (ASCII, and UTF-16LE and BE at either
 * alignment, the equivalent of `strings -a`, `-el` and `-eb`), deduplicated, in order of
 * appearance. Throws once the strings pass {@link MAX_BINARY_STRINGS_ABSOLUTE}, so a huge binary
 * is not read to its end first.
 */
function addedStrings(body: string, path: string): string[] {
  const seen = new Set<string>();
  let total = 0;
  const emit = (text: string) => {
    if (seen.has(text)) {
      return;
    }
    seen.add(text);
    total += text.length + 1;
    if (total > MAX_BINARY_STRINGS_ABSOLUTE) {
      throw ApplicationFailure.nonRetryable(
        `The binary file ${path} holds more than ${MAX_BINARY_STRINGS_ABSOLUTE} characters of ` +
          'printable strings, so it cannot be reduced to a stand-in for the security scan. ' +
          'Nothing further was run.',
        'SECURITY_GATE_UNAVAILABLE'
      );
    }
  };
  for (const line of addedLines(body)) {
    runsOf(line, 'ascii', emit);
    for (const aligned of [line, line.slice(1)]) {
      runsOf(aligned, 'le', emit);
      runsOf(aligned, 'be', emit);
    }
  }
  return [...seen];
}

/**
 * Whether a string has the shape of a credential: what {@link maskCredentialShapes} would mask
 * (URL userinfo, auth headers, `*_SECRET=` assignments, well-known token prefixes) or any
 * CRITICAL pre-write rule (AWS keys, hardcoded secrets, private keys). A local, deterministic
 * check, so a secret in a binary's strings is kept for the model even when the strings are too
 * many to show whole.
 */
export function isCredentialShaped(text: string): boolean {
  if (maskCredentialShapes(text) !== text) {
    return true;
  }
  return SECURITY_RULES.some((rule) => rule.severity === 'CRITICAL' && rule.pattern.test(text));
}

function standIn(section: string): string {
  const hunk = section.search(/^@@/m);
  const header = hunk === -1 ? section : section.slice(0, hunk);
  const body = hunk === -1 ? '' : section.slice(hunk);
  const path = sectionPath(section);
  const strings = addedStrings(body, path);
  const total = strings.reduce((sum, s) => sum + s.length + 1, 0);
  const kept: string[] = [];
  let note = '';
  if (total <= MAX_BINARY_STRINGS_CHARS) {
    kept.push(...strings);
  } else {
    let used = 0;
    let index = 0;
    for (; index < strings.length; index++) {
      const s = strings[index] as string;
      if (used + s.length + 1 > MAX_BINARY_STRINGS_CHARS) {
        break;
      }
      kept.push(s);
      used += s.length + 1;
    }
    // The strings past the cap are not shown to the model, but each is checked locally and a
    // credential-shaped one is kept.
    let shapedChars = 0;
    let shaped = 0;
    for (const s of strings.slice(index)) {
      if (shapedChars >= MAX_SHAPED_TOTAL_CHARS) {
        break;
      }
      if (isCredentialShaped(s)) {
        const clipped = s.slice(0, MAX_SHAPED_STRING_CHARS);
        kept.push(clipped);
        shapedChars += clipped.length + 1;
        shaped++;
      }
    }
    note =
      `; strings truncated: the first ${index} of ${strings.length} are listed, plus ${shaped} ` +
      'credential-shaped string(s) from the rest';
  }
  return (
    `${header}Binary content of ${path} (${body.length} characters of patch text, ` +
    `${strings.length} printable strings of ${MIN_STRING_LENGTH}+ characters${note}, ` +
    `listed as added lines):\n${kept.map((s) => `+${s}\n`).join('')}`
  );
}

/** Control characters other than tab, newline and carriage return (NUL included). */
function isControl(code: number): boolean {
  return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (isControl(text.charCodeAt(i))) {
      return true;
    }
  }
  return false;
}

/** NUL and the other control characters (not tab, newline, carriage return) made visible. */
function showControlChars(text: string): string {
  let out = '';
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isControl(code)) {
      out +=
        text.slice(from, i) + (code === 0 ? '\\0' : `\\x${code.toString(16).padStart(2, '0')}`);
      from = i + 1;
    }
  }
  return out + text.slice(from);
}

/** Whether an added line of the section carries a NUL byte. */
function addsNul(section: string): boolean {
  return addedLines(section).some((line) => line.includes('\0'));
}

/**
 * The scanner input for a pinned patch. A section for a file that is binary by name and holds a
 * NUL becomes its stand-in; every other section is kept whole with control characters made
 * visible, and one that adds a NUL byte is preceded by a {@link NUL_NOTICE_PREFIX} line. Throws
 * `SECURITY_GATE_UNAVAILABLE` (non-retryable) naming the file when a binary's strings exceed
 * {@link MAX_BINARY_STRINGS_ABSOLUTE}.
 */
export function standInBinarySections(patch: string): string {
  if (!hasControlChars(patch)) {
    return patch;
  }
  return splitSections(patch)
    .map((section) => {
      if (!hasControlChars(section)) {
        return section;
      }
      const path = sectionPath(section);
      if (isBinaryPath(path) && section.includes('\0')) {
        return standIn(section);
      }
      const notice = addsNul(section) ? `${NUL_NOTICE_PREFIX}${path}]\n` : '';
      return notice + showControlChars(section);
    })
    .join('');
}

/**
 * The files {@link standInBinarySections} announced as holding a NUL byte although they are not
 * binary by name. A notice line starts at column 0, which no patch content line can (each carries a
 * `+`, `-` or space prefix), so file content cannot forge or hide one.
 */
export function nulNoticePaths(scannerInput: string): string[] {
  const paths: string[] = [];
  for (const line of scannerInput.split('\n')) {
    if (line.startsWith(NUL_NOTICE_PREFIX) && line.endsWith(']')) {
      paths.push(line.slice(NUL_NOTICE_PREFIX.length, -1));
    }
  }
  return paths;
}
