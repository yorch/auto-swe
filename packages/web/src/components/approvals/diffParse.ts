// Detects unified diff (git or patch format)
export function isUnifiedDiff(str: string): boolean {
  return str.trimStart().startsWith('diff --git') || str.includes('\n@@ ') || str.startsWith('@@ ');
}

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export interface ParsedDiffLine {
  kind: DiffLineKind;
  text: string;
  /** Line number in the old file; null for added, hunk and meta lines. */
  oldNo: number | null;
  /** Line number in the new file; null for removed, hunk and meta lines. */
  newNo: number | null;
}

export interface ParsedDiffFile {
  name: string;
  added: number;
  removed: number;
  lines: ParsedDiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function fileNameFromHeader(line: string): string {
  // `diff --git a/path b/path` — take the b/ side.
  const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
  if (match) {
    return match[2];
  }
  return line.replace(/^diff\s+(--git\s+)?/, '');
}

/** Split a unified diff into per-file groups with old/new line numbers from the hunk headers. */
export function parseUnifiedDiff(content: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: ParsedDiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  // Lines the open hunk still owes, from its header. A plain `diff -u` of several files has no
  // per-file `diff --git` line to end a hunk, so the counts are what say where it stops.
  let oldLeft = 0;
  let newLeft = 0;
  let seenHunk = false;

  const start = (name: string): ParsedDiffFile => {
    const file: ParsedDiffFile = { added: 0, lines: [], name, removed: 0 };
    files.push(file);
    return file;
  };

  for (const raw of content.split('\n')) {
    if (raw.startsWith('diff ')) {
      current = start(fileNameFromHeader(raw));
      inHunk = false;
      seenHunk = false;
      current.lines.push({ kind: 'meta', newNo: null, oldNo: null, text: raw });
      continue;
    }
    if (!current) {
      // A bare patch with no `diff` header: group everything under one file.
      current = start('Changes');
    }
    if (!inHunk && seenHunk && raw.startsWith('--- ')) {
      // The next file of a diff that carries no `diff` header lines.
      current = start('Changes');
      seenHunk = false;
    }
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newNo = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      inHunk = oldLeft > 0 || newLeft > 0;
      seenHunk = true;
      current.lines.push({ kind: 'hunk', newNo: null, oldNo: null, text: raw });
      continue;
    }
    if (!inHunk) {
      // File header lines (index, ---, +++) before the first hunk.
      if (raw.startsWith('+++ ')) {
        const name = (raw.slice(4).split('\t')[0] ?? '').replace(/^b\//, '');
        if (name !== '/dev/null' && current.name === 'Changes') {
          current.name = name;
        }
      }
      if (raw !== '') {
        current.lines.push({ kind: 'meta', newNo: null, oldNo: null, text: raw });
      }
      continue;
    }
    if (raw.startsWith('+')) {
      current.added += 1;
      newLeft -= 1;
      current.lines.push({ kind: 'add', newNo: newNo++, oldNo: null, text: raw });
    } else if (raw.startsWith('-')) {
      current.removed += 1;
      oldLeft -= 1;
      current.lines.push({ kind: 'del', newNo: null, oldNo: oldNo++, text: raw });
    } else if (raw.startsWith('\\')) {
      current.lines.push({ kind: 'meta', newNo: null, oldNo: null, text: raw });
    } else {
      oldLeft -= 1;
      newLeft -= 1;
      current.lines.push({ kind: 'ctx', newNo: newNo++, oldNo: oldNo++, text: raw });
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      inHunk = false;
    }
  }
  // A trailing empty context line is just the final newline.
  for (const file of files) {
    const last = file.lines[file.lines.length - 1];
    if (last && last.kind === 'ctx' && last.text === '') {
      file.lines.pop();
    }
  }
  return files.filter((f) => f.lines.length > 0);
}
