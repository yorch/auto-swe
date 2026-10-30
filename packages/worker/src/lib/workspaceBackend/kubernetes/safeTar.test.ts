import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeArchive, readSingleFileFromArchive, UnsafeArchiveError } from './safeTar.js';
import { buildTar, type TarEntry } from './testTar.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'safetar-'));
});
afterEach(async () => {
  await fs.rm(dir, { force: true, recursive: true });
});

async function check(entries: TarEntry[], opts?: { terminate?: boolean }): Promise<void> {
  const file = path.join(dir, 'a.tar');
  await fs.writeFile(file, buildTar(entries, opts));
  await assertSafeArchive(file);
}

const refuses = (entries: TarEntry[], reason: RegExp, opts?: { terminate?: boolean }) =>
  expect(check(entries, opts)).rejects.toThrow(reason);

describe('assertSafeArchive', () => {
  it('accepts ordinary files, directories and contained relative symlinks', async () => {
    await check([
      { name: './', type: '5' },
      { data: 'hello', name: './src/a.ts' },
      { name: './src/', type: '5' },
      { linkname: 'a.ts', name: './src/link', type: '2' },
      { linkname: '../src/a.ts', name: './other/link', type: '2' },
    ]);
  });

  it('accepts an empty archive', async () => {
    await check([]);
  });

  it('refuses an absolute path and a path that climbs out', async () => {
    await refuses([{ data: 'x', name: '/etc/passwd' }], /absolute path/);
    await refuses([{ data: 'x', name: 'a/../../etc/passwd' }], /climbs out/);
    await refuses([{ data: 'x', name: '../escape' }], /climbs out/);
  });

  it('refuses hard links, devices and other special entries', async () => {
    await refuses([{ linkname: 'a', name: 'b', type: '1' }], /not allowed/);
    await refuses([{ name: 'dev', type: '3' }], /not allowed/);
    await refuses([{ name: 'fifo', type: '6' }], /not allowed/);
  });

  it('refuses a symlink with an absolute target', async () => {
    await refuses([{ linkname: '/etc', name: 'x', type: '2' }], /absolute or empty target/);
    await refuses([{ linkname: '', name: 'x', type: '2' }], /absolute or empty target/);
  });

  it('refuses a symlink that points above the archive root', async () => {
    await refuses([{ linkname: '..', name: 'x', type: '2' }], /above the archive root/);
    await refuses([{ linkname: '../..', name: 'a/x', type: '2' }], /above the archive root/);
  });

  it('refuses a symlink that climbs after descending, even when it looks contained', async () => {
    // p/q/d -> ../../top is fine; p/q/d/../../x would escape once d resolves.
    await refuses([{ linkname: 'sub/../../x', name: 'e', type: '2' }], /climbs after descending/);
  });

  it('refuses writing through a symlink the archive created', async () => {
    await refuses(
      [
        { linkname: 'sub', name: 'a', type: '2' },
        { data: 'x', name: 'a/passwd' },
      ],
      /through a symlink/
    );
  });

  it('refuses reusing a symlink name for a file or directory', async () => {
    await refuses(
      [
        { linkname: 'sub', name: 'a', type: '2' },
        { name: 'a/', type: '5' },
      ],
      /reuses a symlink/
    );
  });

  it('refuses a non-file entry that claims data', async () => {
    await refuses([{ linkname: 'a', name: 'b', size: 512, type: '2' }], /carries data/);
  });

  it('follows GNU long names, so a long escaping path is still caught', async () => {
    await refuses(
      [
        { data: `../${'a'.repeat(150)}\0`, name: '././@LongLink', type: 'L' },
        { data: 'x', name: 'placeholder' },
      ],
      /climbs out/
    );
  });

  it('applies a pax path override to the next entry', async () => {
    const record = ' path=/etc/shadow\n';
    // The length counts its own digits, so settle on a self-consistent value.
    let total = record.length + 1;
    while (String(total).length + record.length !== total) {
      total = String(total).length + record.length;
    }
    const pax = `${total}${record}`;
    await refuses(
      [
        { data: pax, name: 'PaxHeader', type: 'x' },
        { data: 'x', name: 'innocent' },
      ],
      /absolute path/
    );
  });

  it('accepts what the system tar produces for a real tree', async () => {
    const tree = path.join(dir, 'tree');
    const deep = path.join(
      tree,
      ...Array.from({ length: 6 }, () => 'a-rather-long-directory-name')
    );
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(deep, 'файл-ünï.ts'), 'x');
    await fs.writeFile(path.join(tree, 'top.txt'), 'y');
    await fs.symlink('top.txt', path.join(tree, 'link'));
    await fs.symlink('../top.txt', path.join(deep, 'up'));
    const file = path.join(dir, 'real.tar');
    execFileSync('tar', ['cf', file, '-C', tree, '.']);
    await assertSafeArchive(file);
  });

  it('refuses an archive with a corrupt header, or no end marker', async () => {
    const file = path.join(dir, 'bad.tar');
    const tar = buildTar([{ data: 'x', name: 'a' }]);
    tar[10] = (tar[10] ?? 0) ^ 0xff;
    await fs.writeFile(file, tar);
    await expect(assertSafeArchive(file)).rejects.toThrow(/checksum/);
    await refuses([{ data: 'x', name: 'a' }], /end-of-archive/, { terminate: false });
  });

  it('throws UnsafeArchiveError so callers can tell it from an I/O failure', async () => {
    await expect(check([{ data: 'x', name: '/abs' }])).rejects.toBeInstanceOf(UnsafeArchiveError);
  });
});

describe('readSingleFileFromArchive', () => {
  it('reads a bounded regular file from a safe archive', async () => {
    const file = path.join(dir, 'single.tar');
    await fs.writeFile(file, buildTar([{ data: 'hello', name: 'file.txt' }]));
    await expect(readSingleFileFromArchive(file, 5)).resolves.toEqual(Buffer.from('hello'));
    await expect(readSingleFileFromArchive(file, 4)).rejects.toThrow('exceeds the 4 byte limit');
  });

  it('refuses archives with no regular file or multiple regular files', async () => {
    const empty = path.join(dir, 'empty.tar');
    await fs.writeFile(empty, buildTar([{ name: 'folder/', type: '5' }]));
    await expect(readSingleFileFromArchive(empty, 10)).rejects.toThrow(
      'archive does not contain a single regular file'
    );
    const multiple = path.join(dir, 'multiple.tar');
    await fs.writeFile(
      multiple,
      buildTar([
        { data: 'first', name: 'one' },
        { data: 'second', name: 'two' },
      ])
    );
    await expect(readSingleFileFromArchive(multiple, 10)).rejects.toThrow(
      'archive contains more than one regular file'
    );
  });
});
