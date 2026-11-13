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
import { matchesAny } from '@auto-swe/shared/lib/prEvaluation';
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
    '7z a aac aar apk avi avif beam bin blend bmp br bz2 cab class dat db dds deb der dex dll dmg ' +
    'doc docx dylib ear eot exe exr fbx flac gguf gif glb gz h5 heic icns ico img iso jar jks jpeg ' +
    'jpg keystore ktx lib lockb lz lz4 m4a mdb mid mkv mo mov msi mp3 mp4 node npy npz nupkg o obj odt ogg ' +
    'onnx otf parquet pb pdb pdf pfx pickle pkl png ppt pptx psd pt pth p12 pyc pyd pyo rar rlib ' +
    'rpm safetensors snk so sqlite sqlite3 swf tar tflite tga tgz tif tiff ttc ttf wasm war wav ' +
    'webm webp whl woff woff2 xls xlsx xz zip zst'
  ).split(' ')
);

/** Whole file names that are binary whatever their extension (compared case-insensitively). */
const BINARY_NAMES: ReadonlySet<string> = new Set(['.ds_store']);

/**
 * Extensions of files that claim to be text. A file with one of these is never classed binary by
 * its first bytes ({@link hasBinaryMagic}): a script cannot become an "executable" by starting
 * with an ELF header.
 */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    'bash bat c cc cfg cjs cmd conf cpp cs css csv cts cxx dart env erb ex exs fish go gradle h ' +
    'hpp hs html ini java js json jsonc jsx kt kts less lock lua md mdx mjs mts php pl properties ' +
    'ps1 py r rb reg rs rst sass scala scss sh sql strings svelte svg swift tf toml ts tsx txt ' +
    'vue xml yaml yml zsh'
  ).split(' ')
);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Whether `path` is binary by its name: a listed extension or a listed file name (case-insensitive). */
export function isBinaryPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return BINARY_NAMES.has(name) || BINARY_EXTENSIONS.has(extensionOf(path));
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

/**
 * The path git printed for a quoted name (`"we\"ird.png"`), or null when the text is not a
 * well-formed C-style quoted string. Git quotes a name that holds a double quote, a backslash or a
 * control character such as a tab even with `core.quotepath=false` (which only stops it quoting
 * non-ASCII bytes), and writes those as `\"`, `\\`, `\t`, `\n`, ... or a three-digit octal byte.
 */
function unquoteGitPath(quoted: string): string | null {
  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) {
    return null;
  }
  const escapes: Record<string, number> = {
    '"': 0x22,
    '\\': 0x5c,
    a: 0x07,
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
  };
  const bytes: number[] = [];
  const body = quoted.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch === '"') {
      return null;
    }
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      return null;
    }
    if (next in escapes) {
      bytes.push(escapes[next] as number);
      i++;
    } else if (/^[0-7]{3}$/.test(body.slice(i + 1, i + 4))) {
      bytes.push(Number.parseInt(body.slice(i + 1, i + 4), 8) & 0xff);
      i += 3;
    } else {
      return null;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** The end index of the quoted token starting at `from` (the closing quote), or -1. */
function quotedEnd(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
    } else if (text[i] === '"') {
      return i;
    }
  }
  return -1;
}

/** A path as git writes it on a header line: quoted, or verbatim. */
function readGitPath(text: string): string {
  return unquoteGitPath(text) ?? text;
}

/**
 * The (new) path a section is about. A rename or copy names it on a `rename to` or `copy to` line; otherwise it is the
 * `b/` side of the `diff --git` line, which is parsed as git wrote it: a quoted name is unquoted,
 * and for two identical unquoted names the split is found by length, so a name that itself
 * contains ` b/` is not cut in the wrong place.
 */
function sectionPath(section: string): string {
  const hunk = section.search(/^@@/m);
  const header = hunk === -1 ? section : section.slice(0, hunk);
  const renamed = /^(?:rename|copy) to (.*)$/m.exec(header);
  if (renamed) {
    return readGitPath(renamed[1] as string);
  }
  const firstLine = section.slice(
    0,
    section.indexOf('\n') === -1 ? undefined : section.indexOf('\n')
  );
  const rest = firstLine.startsWith('diff --git ') ? firstLine.slice('diff --git '.length) : '';
  let right: string | undefined;
  if (rest.startsWith('"')) {
    const end = quotedEnd(rest, 0);
    if (end !== -1 && rest[end + 1] === ' ') {
      right = rest.slice(end + 2);
    }
  } else if (rest.endsWith('"') && rest.includes(' "b/')) {
    right = rest.slice(rest.indexOf(' "b/') + 1);
  } else {
    const n = (rest.length - 5) / 2;
    if (
      Number.isInteger(n) &&
      n > 0 &&
      rest.startsWith('a/') &&
      rest.slice(2 + n, 5 + n) === ' b/' &&
      rest.slice(2, 2 + n) === rest.slice(5 + n)
    ) {
      return rest.slice(5 + n);
    }
  }
  if (right !== undefined) {
    const value = readGitPath(right);
    return value.startsWith('b/') ? value.slice(2) : value;
  }
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

/** What a character reads as when git's output was decoded as UTF-8 and a byte was not valid. */
const LOST_BYTE = '�';

/** Whether a decoded UTF-16 code unit may appear in text: not NUL, not a control other than TAB/CR. */
function isTextUnit(unit: string): boolean {
  const code = unit.charCodeAt(0);
  return code === 0x09 || code === 0x0d || (code >= 0x20 && code !== 0x7f);
}

/**
 * One line of a UTF-16 file as git printed it, or null when it is not UTF-16 text in `endian`.
 * Git splits a file at each 0x0A byte, which is the low byte of a UTF-16LE newline (so every later
 * line begins with that newline's NUL high byte) and the byte after a BE newline's NUL (so every
 * non-final line ends with that NUL). Only characters whose other byte is NUL are accepted
 * (Latin-1 range text, which is what a settings, script or registry file is), so every byte of the
 * line is either a NUL that is the high half of a character or a character that is shown: nothing
 * is dropped. A byte git's output could not carry as UTF-8 reads as U+FFFD and is shown as such.
 */
function decodeUtf16Line(payload: string, endian: 'le' | 'be', first: boolean): string | null {
  let line = payload;
  if (first && line.startsWith(LOST_BYTE + LOST_BYTE)) {
    line = line.slice(2); // the byte order mark (FF FE or FE FF), two bytes UTF-8 cannot carry
  } else if (endian === 'le' && line.startsWith('\0')) {
    line = line.slice(1); // the high byte of the previous newline
  }
  if (endian === 'be' && line.length % 2 === 1) {
    if (!line.endsWith('\0')) {
      return null;
    }
    line = line.slice(0, -1); // the high byte of this line's newline
  }
  if (line.length % 2 === 1) {
    return null;
  }
  let text = '';
  for (let i = 0; i < line.length; i += 2) {
    const unit = endian === 'le' ? line[i] : line[i + 1];
    const high = endian === 'le' ? line[i + 1] : line[i];
    if (high !== '\0' || unit === undefined || (unit !== LOST_BYTE && !isTextUnit(unit))) {
      return null;
    }
    text += unit;
  }
  return text;
}

/**
 * The section rewritten as UTF-8 text when every content line of it is UTF-16 text (see
 * {@link decodeUtf16Line}), keeping ALL lines (context, removed and added), or null.
 */
function decodeUtf16Section(section: string): string | null {
  const hunk = section.search(/^@@/m);
  if (hunk === -1) {
    return null;
  }
  const header = section.slice(0, hunk);
  const lines = section.slice(hunk).split('\n');
  for (const endian of ['le', 'be'] as const) {
    const out: string[] = [];
    let first = false;
    let ok = true;
    let sawText = false;
    for (const line of lines) {
      if (line.startsWith('@@')) {
        first = /^@@ -\S+ \+1(?:,\d+)? @@/.test(line);
        out.push(line);
      } else if (line.startsWith('\\') || line === '') {
        out.push(line);
      } else if (line[0] === '+' || line[0] === '-' || line[0] === ' ') {
        const text = decodeUtf16Line(line.slice(1), endian, first);
        first = false;
        if (text === null) {
          ok = false;
          break;
        }
        sawText ||= text.length > 0;
        out.push(line[0] + text);
      } else {
        ok = false;
        break;
      }
    }
    if (ok && sawText) {
      return header + out.join('\n');
    }
  }
  return null;
}

/**
 * The first bytes of the file a section is about, as the patch shows them: only when its first hunk
 * starts at line 1, which is every added file and any change near the top.
 */
function fileHead(section: string): string {
  const hunk = section.search(/^@@ -\S+ \+1(?:,\d+)? @@.*$/m);
  if (hunk === -1) {
    return '';
  }
  let head = '';
  for (const line of section.slice(section.indexOf('\n', hunk) + 1).split('\n')) {
    if (line.startsWith('@@') || head.length > 4096) {
      break;
    }
    if (line[0] === '+' || line[0] === ' ') {
      head += `${line.slice(1)}\n`;
    }
  }
  return head;
}

/** The 4-byte magic numbers of Mach-O (thin and fat) and Java class files, as raw bytes. */
const FOUR_BYTE_MAGICS: readonly (readonly number[])[] = [
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe], // a fat Mach-O binary or a Java class: both are binary
];

/**
 * Whether a file's first bytes are those of an executable or archive container: ELF, Mach-O (and
 * Java class), PE, WebAssembly, ZIP or gzip. Judged only for a name that does not claim to be text
 * ({@link TEXT_EXTENSIONS}), so the rule widens "binary" for the odd-named and extension-less file
 * (`tools/protoc`) and never lets a `.js` file shed its lines by starting with `\x7fELF`. The bytes
 * above 0x7F come through as U+FFFD (or, if a backend decodes as Latin-1, as themselves).
 */
function hasBinaryMagic(section: string, path: string): boolean {
  if (TEXT_EXTENSIONS.has(extensionOf(path))) {
    return false;
  }
  const head = fileHead(section);
  if (
    head.startsWith('\x7fELF') ||
    head.startsWith('PK\x03\x04') ||
    head.startsWith('\0asm') ||
    head.startsWith('\x1f�') ||
    head.startsWith('\x1f\x8b') ||
    (head.startsWith('MZ') && head.includes('PE\0\0'))
  ) {
    return true;
  }
  const first4 = [...head.slice(0, 4)];
  return (
    first4.length === 4 &&
    (first4.every((c) => c === LOST_BYTE) ||
      FOUR_BYTE_MAGICS.some((magic) => magic.every((byte, i) => first4[i]?.charCodeAt(0) === byte)))
  );
}

/** What {@link standInBinarySections} may be told about the deployment. */
export interface StandInOptions {
  /**
   * Path globs (the `workspace.nulAllowedPaths` setting) whose files may hold a NUL byte although
   * they are not binary by name: they are reduced to their strings like a binary instead of being
   * announced as a NUL in a text file.
   */
  nulAllowedPaths?: readonly string[];
}

/**
 * The scanner input for a pinned patch. A section for a file that is binary BY NAME and holds a NUL
 * becomes its stand-in, and so does one whose first bytes are an executable or archive header (for
 * a name that does not claim to be text) or whose path is on the `nulAllowedPaths` list. A section
 * that is UTF-16 text is decoded and kept whole. Every other section is kept whole with control
 * characters made visible, and one that adds a NUL byte is preceded by a {@link NUL_NOTICE_PREFIX}
 * line. Throws `SECURITY_GATE_UNAVAILABLE` (non-retryable) naming the file when a binary's strings
 * exceed {@link MAX_BINARY_STRINGS_ABSOLUTE}.
 */
export function standInBinarySections(patch: string, options: StandInOptions = {}): string {
  if (!hasControlChars(patch)) {
    return patch;
  }
  const allowed = options.nulAllowedPaths ?? [];
  return splitSections(patch)
    .map((section) => {
      if (!hasControlChars(section)) {
        return section;
      }
      const path = sectionPath(section);
      const hasNul = section.includes('\0');
      if (hasNul && isBinaryPath(path)) {
        return standIn(section);
      }
      if (hasNul) {
        const text = decodeUtf16Section(section);
        if (text !== null) {
          return showControlChars(text);
        }
        if ((allowed.length > 0 && matchesAny(path, allowed)) || hasBinaryMagic(section, path)) {
          return standIn(section);
        }
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
