import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { unsafeProfilePath } from './paths.js';
import { packFiles, unpackAndVerify, unpackFiles } from './snapshot.js';
import { file, validFiles } from './testing.js';
import { PROFILE_LIMITS } from './types.js';
import { computeContentHash, validateProfile } from './validate.js';

describe('snapshot', () => {
  it('round-trips bytes, modes and paths, including binary content', () => {
    const files = [
      file('b.md', 'B'),
      file('a/run.sh', '#!/bin/sh\n', '100755'),
      { bytes: Buffer.from([0, 255, 1]), mode: '100644' as const, path: 'bin.dat' },
    ];
    const back = unpackFiles(packFiles(files));
    expect(back.map((f) => f.path)).toEqual(['a/run.sh', 'b.md', 'bin.dat']);
    expect(back[0]?.mode).toBe('100755');
    expect(back[2]?.bytes.equals(Buffer.from([0, 255, 1]))).toBe(true);
  });

  it('refuses a tampered snapshot with an unsafe path', () => {
    const blob = gzipSync(JSON.stringify([{ content: '', mode: '100644', path: '../evil' }]));
    expect(() => unpackFiles(blob)).toThrow('unsafe path');
  });

  it('refuses a decompression bomb and malformed content', () => {
    expect(() => unpackFiles(gzipSync(Buffer.alloc(20_000_000, 'a')))).toThrow();
    expect(() => unpackFiles(gzipSync('{"a":1}'))).toThrow();
  });

  it('refuses duplicates, case collisions, too many files and oversize content on unpack', () => {
    const pack = (entries: unknown[]) => gzipSync(JSON.stringify(entries));
    const e = (path: string, content = '') => ({ content, mode: '100644', path });
    expect(() => unpackFiles(pack([e('a.md'), e('a.md')]))).toThrow('duplicate');
    expect(() => unpackFiles(pack([e('Docs.md'), e('docs.md')]))).toThrow('duplicate');
    expect(() =>
      unpackFiles(pack(Array.from({ length: PROFILE_LIMITS.maxFiles + 1 }, (_, i) => e(`f${i}`))))
    ).toThrow('too many');
    const big = Buffer.alloc(PROFILE_LIMITS.maxFileBytes + 1).toString('base64');
    expect(() => unpackFiles(pack([e('big', big)]))).toThrow('size limits');
  });

  it('packs and unpacks a snapshot at every path and size limit', () => {
    // Worst case for JSON size: every byte of a maximal path is a character that escapes.
    const quotes = Array.from({ length: 4 }, () => '"'.repeat(255)).join('/');
    expect(unsafeProfilePath(quotes)).toBeNull();
    const files = Array.from({ length: PROFILE_LIMITS.maxFiles }, (_, i) => ({
      bytes: Buffer.alloc(PROFILE_LIMITS.maxTotalBytes / PROFILE_LIMITS.maxFiles, i % 251),
      mode: '100644' as const,
      path: i === 0 ? quotes : `${String(i).padStart(3, '0')}/${'é'.repeat(100)}`,
    }));
    expect(unpackFiles(packFiles(files))).toHaveLength(PROFILE_LIMITS.maxFiles);
  }, 30_000);

  describe('path length', () => {
    it('refuses a segment over 255 bytes and a path over 1024 bytes', () => {
      expect(unsafeProfilePath('a'.repeat(255))).toBeNull();
      expect(unsafeProfilePath('a'.repeat(256))).toMatch(/segment longer/);
      expect(unsafeProfilePath('é'.repeat(128))).toMatch(/segment longer/);
      expect(unsafeProfilePath(Array.from({ length: 5 }, () => 'a'.repeat(250)).join('/'))).toMatch(
        /path longer/
      );
    });
  });

  describe('unpackAndVerify', () => {
    const approved = () => {
      const files = validFiles();
      const v = validateProfile(files);
      if (!v.ok) {
        throw new Error('invalid fixture');
      }
      return { files, hash: v.contentHash, manifest: v.manifest };
    };

    it('returns the files of an untouched snapshot', () => {
      const { files, hash, manifest } = approved();
      expect(unpackAndVerify(packFiles(files), manifest, hash)).toHaveLength(files.length);
    });

    it('refuses a tampered file, an extra file and a changed mode', () => {
      const { files, hash, manifest } = approved();
      const tampered = files.map((f) =>
        f.path.endsWith('hello.md') ? { ...f, bytes: Buffer.from('Say goodbye') } : f
      );
      expect(() => unpackAndVerify(packFiles(tampered), manifest, hash)).toThrow('content hash');
      expect(() =>
        unpackAndVerify(packFiles([...files, file('plugins/foo/extra.sh', 'x')]), manifest, hash)
      ).toThrow('content hash');
      const modded = files.map((f) =>
        f.path === 'INSTRUCTIONS.md' ? { ...f, mode: '100755' as const } : f
      );
      expect(() => unpackAndVerify(packFiles(modded), manifest, hash)).toThrow('content hash');
      expect(computeContentHash(files, manifest)).toBe(hash);
    });

    it('refuses a bomb and a wrong expected hash', () => {
      const { files, hash, manifest } = approved();
      expect(() =>
        unpackAndVerify(gzipSync(Buffer.alloc(20_000_000, 'a')), manifest, hash)
      ).toThrow();
      expect(() => unpackAndVerify(packFiles(files), manifest, 'f'.repeat(64))).toThrow(
        'content hash'
      );
    }, 30_000);
  });
});
