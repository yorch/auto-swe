/** A minimal ustar writer for tests: enough to build good and hostile archives. */
export interface TarEntry {
  name: string;
  /** `0` file, `5` directory, `2` symlink, `1` hard link, `3` char device; `x` pax, `L` GNU long name. */
  type?: string;
  linkname?: string;
  data?: string;
  /** Overrides the size field, to build a header whose size lies. */
  size?: number;
}

const BLOCK = 512;

function field(value: string, length: number): Buffer {
  const buf = Buffer.alloc(length);
  buf.write(value.slice(0, length), 'utf8');
  return buf;
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function header(entry: TarEntry): Buffer {
  const data = Buffer.from(entry.data ?? '');
  const buf = Buffer.alloc(BLOCK);
  field(entry.name, 100).copy(buf, 0);
  field(octal(0o644, 8), 8).copy(buf, 100);
  field(octal(0, 8), 8).copy(buf, 108);
  field(octal(0, 8), 8).copy(buf, 116);
  field(octal(entry.size ?? data.length, 12), 12).copy(buf, 124);
  field(octal(0, 12), 12).copy(buf, 136);
  buf.fill(0x20, 148, 156);
  buf.write(entry.type ?? '0', 156, 'ascii');
  field(entry.linkname ?? '', 100).copy(buf, 157);
  buf.write('ustar\0', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of buf) {
    sum += byte;
  }
  field(`${sum.toString(8).padStart(6, '0')}\0 `, 8).copy(buf, 148);
  return buf;
}

export function buildTar(entries: TarEntry[], opts: { terminate?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(header(entry));
    const data = Buffer.from(entry.data ?? '');
    if (data.length > 0) {
      const padded = Buffer.alloc(Math.ceil(data.length / BLOCK) * BLOCK);
      data.copy(padded);
      parts.push(padded);
    }
  }
  if (opts.terminate !== false) {
    parts.push(Buffer.alloc(BLOCK * 2));
  }
  return Buffer.concat(parts);
}
