import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertValidEntry,
  BUILTIN_TOOL_CATALOG,
  resolveToolRequests,
  type ToolCatalogEntry,
  ToolInstallError,
  toolInstallScript,
} from './toolInstall.js';

const SHA = 'a'.repeat(64);

const entry = (overrides: Partial<ToolCatalogEntry> = {}): ToolCatalogEntry => ({
  archs: {
    amd64: { sha256: SHA, url: 'https://example.test/just-amd64.tar.gz' },
    arm64: { sha256: SHA, url: 'https://example.test/just-arm64.tar.gz' },
  },
  key: 'just',
  member: 'just',
  version: '1.40.0',
  ...overrides,
});

describe('resolveToolRequests', () => {
  it('resolves an exact version and defaults to the last listed one', () => {
    const catalog = [entry({ version: '1.39.0' }), entry({ version: '1.40.0' })];
    expect(resolveToolRequests([{ key: 'just', version: '1.39.0' }], catalog)[0]?.version).toBe(
      '1.39.0'
    );
    expect(resolveToolRequests([{ key: 'just' }], catalog)[0]?.version).toBe('1.40.0');
  });

  it('rejects a tool or version the catalog does not list', () => {
    expect(() => resolveToolRequests([{ key: 'nope' }], [entry()])).toThrow(ToolInstallError);
    expect(() => resolveToolRequests([{ key: 'just', version: '9.9.9' }], [entry()])).toThrow(
      /not in the tool catalog/
    );
  });

  it.each<[string, Partial<ToolCatalogEntry>]>([
    ['a non-https url', { archs: { amd64: { sha256: SHA, url: 'http://example.test/x.tgz' } } }],
    ['a short checksum', { archs: { amd64: { sha256: 'abc', url: 'https://example.test/x' } } }],
    ['a traversing member', { member: '../etc/passwd' }],
    ['a key with a shell metacharacter', { key: 'just;rm' }],
  ])('refuses a catalog entry with %s', (_name, overrides) => {
    expect(() =>
      resolveToolRequests([{ key: overrides.key ?? 'just' }], [entry(overrides)])
    ).toThrow(ToolInstallError);
  });
});

describe('BUILTIN_TOOL_CATALOG', () => {
  it('holds only well-formed, pinned entries for both architectures', () => {
    expect(BUILTIN_TOOL_CATALOG.length).toBeGreaterThan(0);
    for (const entry of BUILTIN_TOOL_CATALOG) {
      expect(() => assertValidEntry(entry)).not.toThrow();
      expect(Object.keys(entry.archs).sort()).toEqual(['amd64', 'arm64']);
    }
  });
});

describe('toolInstallScript', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tool-install-'));
  });
  afterEach(() => rmSync(dir, { force: true, recursive: true }));

  /** A real `.tar.gz` holding an executable `just`, and a catalog entry that points at it. */
  function fixture(sha256Override?: string): ToolCatalogEntry {
    const src = join(dir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'just'), '#!/bin/sh\necho just-ok\n');
    const archive = join(dir, 'just.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', src, 'just']);
    const sha256 =
      sha256Override ?? createHash('sha256').update(readFileSync(archive)).digest('hex');
    const download = { sha256, url: `file://${archive}` };
    return entry({ archs: { amd64: download, arm64: download } });
  }

  const run = (script: string) => spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });

  it('is valid sh', () => {
    execFileSync('/bin/sh', ['-n', '-c', toolInstallScript([entry()])]);
  });

  it('installs a checksum-verified executable into <dir>/bin and leaves no temp files', () => {
    const toolsDir = join(dir, 'tools');
    const result = run(toolInstallScript([fixture()], toolsDir));
    expect(result.status).toBe(0);
    expect(execFileSync(join(toolsDir, 'bin', 'just'), { encoding: 'utf8' })).toBe('just-ok\n');
    expect(readdirSync(toolsDir)).toEqual(['bin']);
  });

  it('fails naming the tool on a checksum mismatch and installs nothing', () => {
    const toolsDir = join(dir, 'tools');
    const result = run(toolInstallScript([fixture('b'.repeat(64))], toolsDir));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('just@1.40.0: checksum mismatch');
    expect(existsSync(join(toolsDir, 'bin', 'just'))).toBe(false);
  });

  it('fails when the download is unreachable', () => {
    const bad = entry({
      archs: {
        amd64: { sha256: SHA, url: `file://${join(dir, 'missing.tar.gz')}` },
        arm64: { sha256: SHA, url: `file://${join(dir, 'missing.tar.gz')}` },
      },
    });
    const result = run(toolInstallScript([bad], join(dir, 'tools')));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('just@1.40.0: download failed');
  });

  it('fails when the archive lacks the declared member', () => {
    const result = run(toolInstallScript([{ ...fixture(), member: 'other' }], join(dir, 'tools')));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('archive has no other');
  });

  it('quotes a hostile-looking url instead of interpreting it', () => {
    const marker = join(dir, 'pwned');
    const hostile = entry({
      archs: {
        amd64: { sha256: SHA, url: `file://x'; touch ${marker}; '` },
        arm64: { sha256: SHA, url: `file://x'; touch ${marker}; '` },
      },
    });
    run(toolInstallScript([hostile], join(dir, 'tools')));
    expect(existsSync(marker)).toBe(false);
  });
});
