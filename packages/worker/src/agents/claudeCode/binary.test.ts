import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  binarySha256,
  claudeBinaryPackage,
  PLATFORM_PROBE,
  parseContainerPlatform,
  resolveClaudeBinary,
} from './binary.js';

describe('parseContainerPlatform', () => {
  it('reads an Alpine image as musl', () => {
    expect(parseContainerPlatform('x86_64\n/lib/ld-musl-x86_64.so.1\n')).toEqual({
      arch: 'x64',
      libc: 'musl',
    });
  });

  it('reads an image with no musl loader as glibc', () => {
    expect(parseContainerPlatform('x86_64\n')).toEqual({ arch: 'x64', libc: 'glibc' });
  });

  it('maps both spellings of 64-bit ARM', () => {
    expect(parseContainerPlatform('aarch64\n/lib/ld-musl-aarch64.so.1').arch).toBe('arm64');
    expect(parseContainerPlatform('arm64\n').arch).toBe('arm64');
  });

  it('rejects an architecture the SDK ships no binary for, without retrying', () => {
    expect(() => parseContainerPlatform('riscv64\n')).toThrow(
      expect.objectContaining({ nonRetryable: true, type: 'HARNESS_UNSUPPORTED_PLATFORM' })
    );
    expect(() => parseContainerPlatform('')).toThrow(/architecture/);
  });

  it('reads a glibc image that also has a musl loader as glibc', () => {
    // Debian with its `musl` package: ldd is glibc's.
    expect(
      parseContainerPlatform(
        'x86_64\n/lib/ld-musl-x86_64.so.1\n/lib64/ld-linux-x86-64.so.2\nldd (Debian GLIBC 2.36-9+deb12u4) 2.36\n'
      ).libc
    ).toBe('glibc');
    // The same without an ldd: the glibc loader decides.
    expect(
      parseContainerPlatform(
        'aarch64\n/lib/ld-musl-aarch64.so.1\n/lib/ld-linux-aarch64.so.1\nsh: ldd: not found\n'
      ).libc
    ).toBe('glibc');
    expect(parseContainerPlatform('x86_64\n\n\nldd (GNU libc) 2.38\n').libc).toBe('glibc');
  });

  it('believes a musl ldd over a glibc-named loader (Alpine with gcompat)', () => {
    expect(
      parseContainerPlatform(
        'x86_64\n/lib/ld-musl-x86_64.so.1\n/lib/ld-linux-x86-64.so.2\nmusl libc (x86_64)\n'
      ).libc
    ).toBe('musl');
  });

  it('probes with a command that always exits zero, so a missing loader is not an error', () => {
    expect(PLATFORM_PROBE).toMatch(/; true$/);
  });
});

describe('claudeBinaryPackage', () => {
  it('names the SDK’s per-platform packages', () => {
    expect(claudeBinaryPackage('x64', 'glibc')).toBe('@anthropic-ai/claude-agent-sdk-linux-x64');
    expect(claudeBinaryPackage('x64', 'musl')).toBe(
      '@anthropic-ai/claude-agent-sdk-linux-x64-musl'
    );
    expect(claudeBinaryPackage('arm64', 'musl')).toBe(
      '@anthropic-ai/claude-agent-sdk-linux-arm64-musl'
    );
  });
});

describe('resolveClaudeBinary', () => {
  it('points at the binary beside the package manifest', () => {
    const seen: string[] = [];
    const found = resolveClaudeBinary('x64', 'musl', (specifier) => {
      seen.push(specifier);
      return '/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/package.json';
    });
    expect(seen).toEqual(['@anthropic-ai/claude-agent-sdk-linux-x64-musl/package.json']);
    expect(found).toBe('/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude');
  });

  it('fails without retrying when the worker was not built for that platform', () => {
    expect(() =>
      resolveClaudeBinary('arm64', 'glibc', () => {
        throw new Error("Cannot find module '…'");
      })
    ).toThrow(expect.objectContaining({ nonRetryable: true, type: 'HARNESS_BINARY_MISSING' }));
  });

  it('resolves the real binary for the platform this worker was installed on', () => {
    // .yarnrc.yml installs both libc variants for the build architecture; a
    // regression there only shows up in a container, so assert it here.
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    for (const libc of ['glibc', 'musl'] as const) {
      expect(resolveClaudeBinary(arch, libc)).toMatch(/claude-agent-sdk-linux-.*\/claude$/);
    }
  });
});

describe('binarySha256', () => {
  it('hashes the file the worker holds', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-bin-'));
    const file = path.join(dir, 'claude');
    writeFileSync(file, 'binary bytes');
    await expect(binarySha256(file)).resolves.toBe(
      createHash('sha256').update('binary bytes').digest('hex')
    );
  });

  it('does not remember a file it could not read', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-bin-'));
    const file = path.join(dir, 'later');
    await expect(binarySha256(file)).rejects.toThrow();
    writeFileSync(file, 'x');
    await expect(binarySha256(file)).resolves.toBe(createHash('sha256').update('x').digest('hex'));
  });
});
