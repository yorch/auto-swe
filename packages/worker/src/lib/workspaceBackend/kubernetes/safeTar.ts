import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Why this exists. Under Docker the daemon extracts a copied archive, in a way
 * that cannot be steered by what is inside it. On Kubernetes the only extractor
 * is the `tar` in a pod, run on a stream the agent produced (the working tree
 * is exported by the agent's own `tar`, which the agent could have replaced).
 * So the worker reads the archive itself first and refuses anything an
 * extraction could use to write outside the destination:
 *  - an absolute path or a `..` segment;
 *  - a hard link, device, FIFO or any entry type but file, directory, symlink;
 *  - an entry that sits below a symlink the same archive created (the classic
 *    "link to /etc, then write through it");
 *  - a symlink whose target is absolute, or climbs with `..` anywhere but the
 *    start, or climbs above the archive root.
 *
 * The symlink rule is stricter than "normalises to something inside". A target
 * such as `p/q/d/../../x` looks contained lexically but escapes when `d` is
 * itself a link to a shallower directory. Allowing `..` only as a leading run,
 * never more than the link's depth, makes every chain of links stay inside by
 * induction: each hop starts in a real directory (no ancestor is a link), goes
 * up at most to the root, then only forward.
 */
export class UnsafeArchiveError extends Error {
  constructor(reason: string) {
    super(`unsafe archive: ${reason}`);
    this.name = 'UnsafeArchiveError';
  }
}

const BLOCK = 512;
/** A pax or GNU long-name record is a path, not a payload; a bigger one is not honest. */
const MAX_META_BYTES = 64 * 1024;

const text = (buf: Buffer, start: number, end: number): string => {
  const slice = buf.subarray(start, end);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8');
};

function parseSize(header: Buffer): number {
  // GNU base-256 for sizes that do not fit the 11 octal digits.
  if ((header[124] ?? 0) & 0x80) {
    let n = (header[124] ?? 0) & 0x7f;
    for (let i = 125; i < 136; i++) {
      n = n * 256 + (header[i] ?? 0);
      if (!Number.isSafeInteger(n)) {
        throw new UnsafeArchiveError('entry size out of range');
      }
    }
    return n;
  }
  const raw = text(header, 124, 136).trim();
  if (!/^[0-7]*$/.test(raw)) {
    throw new UnsafeArchiveError('malformed entry size');
  }
  return raw === '' ? 0 : Number.parseInt(raw, 8);
}

function checksumOk(header: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  }
  const stored = Number.parseInt(text(header, 148, 156).trim() || '-1', 8);
  return stored === sum;
}

/** A pax payload: `<len> <key>=<value>\n` records. */
function parsePax(data: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const len = Number(data.subarray(pos, space === -1 ? pos : space).toString('ascii'));
    if (
      space === -1 ||
      !Number.isInteger(len) ||
      len <= space - pos + 1 ||
      pos + len > data.length
    ) {
      throw new UnsafeArchiveError('malformed pax record');
    }
    const record = data.subarray(space + 1, pos + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) {
      out.set(record.slice(0, eq), record.slice(eq + 1));
    }
    pos += len;
  }
  return out;
}

/** The archive-relative path of an entry, or throws if it could escape. */
function entryPath(raw: string): string {
  if (raw.includes('\0')) {
    throw new UnsafeArchiveError('entry name contains a NUL');
  }
  if (raw.startsWith('/')) {
    throw new UnsafeArchiveError(`absolute path: ${raw.slice(0, 80)}`);
  }
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) {
    throw new UnsafeArchiveError(`path climbs out of the destination: ${raw.slice(0, 80)}`);
  }
  return segments.join('/');
}

function assertSymlinkTarget(entry: string, target: string): void {
  if (target === '' || target.includes('\0') || target.startsWith('/')) {
    throw new UnsafeArchiveError(`symlink ${entry.slice(0, 80)} has an absolute or empty target`);
  }
  const segments = target.split('/').filter((s) => s !== '' && s !== '.');
  const ups = segments.findIndex((s) => s !== '..');
  const leading = ups === -1 ? segments.length : ups;
  if (segments.slice(leading).includes('..')) {
    throw new UnsafeArchiveError(`symlink ${entry.slice(0, 80)} climbs after descending`);
  }
  const depth = entry.split('/').length - 1;
  if (leading > depth) {
    throw new UnsafeArchiveError(`symlink ${entry.slice(0, 80)} points above the archive root`);
  }
}

/**
 * Read `file` (a tar stream on the host) and throw {@link UnsafeArchiveError}
 * unless every entry is safe to extract under a directory of the caller's
 * choosing. Reads headers only; entry data is skipped, not buffered.
 */
export async function assertSafeArchive(file: string): Promise<void> {
  const handle = await fs.open(file, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const links = new Set<string>();
    const header = Buffer.alloc(BLOCK);
    let pos = 0;
    let pendingPath: string | undefined;
    let pendingLink: string | undefined;

    const readData = async (at: number, length: number): Promise<Buffer> => {
      if (length > MAX_META_BYTES) {
        throw new UnsafeArchiveError('oversized name record');
      }
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, at);
      if (bytesRead !== length) {
        throw new UnsafeArchiveError('truncated archive');
      }
      return buf;
    };

    while (pos + BLOCK <= fileSize) {
      const { bytesRead } = await handle.read(header, 0, BLOCK, pos);
      if (bytesRead !== BLOCK) {
        throw new UnsafeArchiveError('truncated archive');
      }
      if (header.every((b) => b === 0)) {
        return;
      }
      if (!checksumOk(header)) {
        throw new UnsafeArchiveError('bad header checksum');
      }
      const size = parseSize(header);
      const dataStart = pos + BLOCK;
      const next = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      const type = String.fromCharCode(header[156] ?? 0);

      if (type === 'L' || type === 'K') {
        const value = text(await readData(dataStart, size), 0, size);
        if (type === 'L') {
          pendingPath = value;
        } else {
          pendingLink = value;
        }
        pos = next;
        continue;
      }
      if (type === 'x' || type === 'g') {
        const records = parsePax(await readData(dataStart, size));
        if (type === 'g') {
          for (const key of ['path', 'linkpath', 'size']) {
            if (records.has(key)) {
              throw new UnsafeArchiveError(`global pax header sets ${key}`);
            }
          }
        } else {
          pendingPath = records.get('path') ?? pendingPath;
          pendingLink = records.get('linkpath') ?? pendingLink;
          if (records.has('size')) {
            // A pax-overridden size changes where the next header is; refuse
            // rather than guess, since a wrong guess desynchronises the walk.
            throw new UnsafeArchiveError('pax size override');
          }
        }
        pos = next;
        continue;
      }

      const posix = text(header, 257, 263) === 'ustar';
      const prefix = posix ? text(header, 345, 500) : '';
      const name = text(header, 0, 100);
      const entry = entryPath(pendingPath ?? (prefix ? `${prefix}/${name}` : name));
      const linkTarget = pendingLink ?? text(header, 157, 257);
      pendingPath = undefined;
      pendingLink = undefined;

      // An ancestor that is a link means this write would go through it.
      const parts = entry.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (links.has(parts.slice(0, i).join('/'))) {
          throw new UnsafeArchiveError(`entry written through a symlink: ${entry.slice(0, 80)}`);
        }
      }

      // The same name twice, once as a link, is refused outright: what an
      // extractor does with a directory or file landing on a link varies.
      if (links.has(entry)) {
        throw new UnsafeArchiveError(`entry reuses a symlink's name: ${entry.slice(0, 80)}`);
      }
      const regular = type === '0' || type === '\0' || type === '7';
      if (!regular && size !== 0) {
        // Only a file has data; a wrong size on anything else would
        // desynchronise this walk from the extractor's.
        throw new UnsafeArchiveError(`entry carries data it should not: ${entry.slice(0, 80)}`);
      }
      if (type === '2') {
        assertSymlinkTarget(entry, linkTarget);
        links.add(entry);
      } else if (!regular && type !== '5') {
        throw new UnsafeArchiveError(
          `entry type ${JSON.stringify(type)} is not allowed: ${path.posix.basename(entry).slice(0, 80)}`
        );
      }
      pos = next;
    }
    throw new UnsafeArchiveError('missing end-of-archive marker');
  } finally {
    await handle.close();
  }
}
