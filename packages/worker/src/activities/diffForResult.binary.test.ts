/**
 * Binary files in the scanned diff, against real git. `--text` is what keeps an attribute from
 * hiding a file, and it puts a binary's raw bytes into the patch: a 3 MiB `logo.png` is a
 * three-million-character diff of junk for the security gate, the reviewers and a Temporal payload.
 * A section with a NUL is reduced to a stand-in that keeps the printable strings, so a secret
 * embedded in a binary still reaches the scanner; text stays whole.
 */
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitStaged,
  diffForResult,
  pinnedDiffTreeCommand,
  startPathGuard,
} from './allowedPaths.js';
import {
  MAX_BINARY_STRINGS_ABSOLUTE,
  MAX_BINARY_STRINGS_CHARS,
  nulNoticePaths,
  standInBinarySections,
} from './scanDiffText.js';

const KEY = 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
const MIB = 1024 * 1024;

let dir: string;
const sh = (cmd: string): string =>
  execSync(cmd, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    maxBuffer: 256 * MIB,
    shell: '/bin/sh',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const workspace = { exec: async (cmd: string) => sh(cmd) };
const write = (file: string, data: string | Buffer) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), data);
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'diff-binary-'));
  sh('git init -q -b main && git config user.name t && git config user.email t@t');
  write('README.md', '# base\n');
  sh('git add -A && git commit -q -m base && git update-ref refs/remotes/origin/main HEAD');
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));

async function scanned(): Promise<string> {
  const guard = await startPathGuard(workspace, 'main', undefined);
  sh('git add -A');
  const sha = await commitStaged(workspace, 'auto: implement', guard);
  return diffForResult(workspace, guard, sha);
}

describe('a binary in the diff', () => {
  it('control: the raw pinned patch of a 3 MiB random file is millions of characters', async () => {
    write('logo.png', randomBytes(3 * MIB));
    sh('git add -A && git commit -q -m raw');
    const head = sh('git rev-parse HEAD').trim();
    const raw = await workspace.exec(
      pinnedDiffTreeCommand(sh('git rev-parse HEAD^').trim(), head, { kind: 'patch' })
    );
    expect(raw.length).toBeGreaterThan(2 * MIB);
  });

  it('becomes a small stand-in', async () => {
    write('logo.png', randomBytes(3 * MIB));
    const diff = await scanned();
    expect(diff.length).toBeLessThan(MAX_BINARY_STRINGS_CHARS + 2048);
    expect(diff).toContain('diff --git a/logo.png b/logo.png');
    expect(diff).toContain('Binary content of logo.png');
    expect(diff).toContain('new file mode');
    expect(diff).not.toContain('\0');
  });

  it('still hands the scanner a key embedded in a 3 MiB binary', async () => {
    write(
      'logo.png',
      Buffer.concat([randomBytes(MIB), Buffer.from(`\0${KEY}\0`), randomBytes(2 * MIB)])
    );
    const diff = await scanned();
    expect(diff.length).toBeLessThan(MAX_BINARY_STRINGS_CHARS + 2048);
    expect(diff).toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  });

  it('keeps text sections whole, next to a binary one', async () => {
    const text = `${'// filler\n'.repeat(20000)}const k = "${KEY}";\n`;
    write('big.ts', text);
    write('logo.png', randomBytes(MIB));
    write('yarn.lock', `token = "${KEY}"\n`);
    const diff = await scanned();
    expect(diff).toContain('diff --git a/big.ts b/big.ts');
    expect(diff.split('+// filler\n').length - 1).toBe(20000);
    expect(diff).toContain(`+const k = "${KEY}";`);
    expect(diff).toContain('diff --git a/yarn.lock b/yarn.lock');
  });

  it('keeps the first strings of a large legitimate binary and marks the stand-in truncated', async () => {
    const strings = Array.from({ length: 9000 }, (_, i) => `symbol_name_${i}`).join('\0');
    write('lib/native.so', Buffer.from(`\0${strings}\0`));
    const diff = await scanned();
    expect(diff).toContain('strings truncated');
    expect(diff).toContain('+symbol_name_0\n');
    expect(diff.length).toBeLessThan(MAX_BINARY_STRINGS_CHARS + 8192);
  });

  it('keeps a credential-shaped string from beyond the cap', async () => {
    const filler = Array.from({ length: 9000 }, (_, i) => `symbol_name_${i}`);
    write('lib/native.so', Buffer.from(`\0${[...filler, KEY].join('\0')}\0`));
    const diff = await scanned();
    expect(diff).toContain('strings truncated');
    expect(diff).toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  });

  it('control: a secret in UTF-16 text has no ASCII run for a strings pass to find', async () => {
    const utf16 = Buffer.from(`${KEY}\n`, 'utf16le');
    expect(/[\x20-\x7e]{8,}/.test(utf16.toString('latin1'))).toBe(false);
  });

  it.each([
    ['UTF-16LE', 'utf16le'],
    ['UTF-16BE', 'utf16be'],
  ] as const)('reads a %s secret inside a binary', async (_name, encoding) => {
    const text = Buffer.from(`${KEY}\n`, 'utf16le');
    const data = encoding === 'utf16le' ? text : Buffer.from(text).swap16();
    write('assets/blob.dat', Buffer.concat([Buffer.from([0, 1, 2, 3]), data]));
    const diff = await scanned();
    expect(diff).toContain('Binary content of assets/blob.dat');
    expect(diff).toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  });

  it('keeps every line of a source file with a NUL in it, and announces the NUL', async () => {
    write(
      'evil.js',
      "// \0\nconst a=1\nb=2\nconst k='AKIA'\n+'IOSFODNN'\nfetch(u)\nfetch(u)\nfetch(u)\neval(x)\n"
    );
    const diff = await scanned();
    expect(diff).not.toContain('\0');
    expect(diff).not.toContain('Binary content');
    for (const line of ['+// \\0', '+const a=1', '+b=2', '+eval(x)']) {
      expect(diff).toContain(`${line}\n`);
    }
    // The three identical short lines are three lines, not one deduplicated string.
    expect(diff.split('+fetch(u)\n').length - 1).toBe(3);
    expect(nulNoticePaths(diff)).toEqual(['evil.js']);
  });

  it('decodes a UTF-16 text file instead of announcing it, and keeps its secret in view', async () => {
    write('notes.txt', Buffer.from(`${KEY}\n`, 'utf16le'));
    const diff = await scanned();
    expect(nulNoticePaths(diff)).toEqual([]);
    expect(diff).not.toContain('\0');
    expect(diff).toContain(`+${KEY}\n`);
  });

  it('announces nothing for a binary by name', async () => {
    write('logo.png', randomBytes(MIB));
    expect(nulNoticePaths(await scanned())).toEqual([]);
  });
});

describe('standInBinarySections', () => {
  const header =
    'diff --git a/x.bin b/x.bin\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/x.bin\n';

  it('returns a patch with no NUL untouched', () => {
    const patch = `${header}@@ -0,0 +1 @@\n+hello world\n`;
    expect(standInBinarySections(patch)).toBe(patch);
  });

  it('keeps the header and the added strings, deduplicated, and drops the rest', () => {
    const patch = `${header}@@ -0,0 +1,3 @@\n+\0\0\u0001secret-token-123456\0\0abc\n+secret-token-123456\0\u0002\u0003\n+short\n`;
    const out = standInBinarySections(patch);
    expect(out).toContain(header);
    expect(out.split('secret-token-123456').length - 1).toBe(1);
    expect(out).not.toContain('abc\n');
    expect(out).not.toContain('\0');
  });

  it('ignores strings on removed lines', () => {
    const out = standInBinarySections(
      `${header}@@ -1 +0,0 @@\n-removed-secret-string\0\n+kept-added-string\0\n`
    );
    expect(out).toContain('+kept-added-string');
    expect(out).not.toContain('removed-secret-string');
  });

  it('reduces only the section that has a NUL', () => {
    const text = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
    const out = standInBinarySections(`${text}${header}@@ -0,0 +1 @@\n+\0binary-string-here\n`);
    expect(out.startsWith(text)).toBe(true);
    expect(out).toContain('+binary-string-here');
  });

  it('fails closed, naming the file, only above the absolute bound', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `+${`${i}`.padStart(8, '0')}`.repeat(1));
    const huge = `${header}@@ -0,0 +1 @@\n+\0${'x'.repeat(MAX_BINARY_STRINGS_ABSOLUTE + 1)}\n${lines.join('\n')}\n`;
    let failure: { type?: string; message?: string; nonRetryable?: boolean } | undefined;
    try {
      standInBinarySections(huge);
    } catch (err) {
      failure = err as typeof failure;
    }
    expect(failure?.type).toBe('SECURITY_GATE_UNAVAILABLE');
    expect(failure?.nonRetryable).toBe(true);
    expect(failure?.message).toContain('x.bin');
  });

  it('decides binary by name: a NUL in a .js file does not reduce it to its long strings', () => {
    const patch =
      'diff --git a/e.js b/e.js\n--- /dev/null\n+++ b/e.js\n@@ -0,0 +1,2 @@\n+// \0\n+b=2\n';
    const out = standInBinarySections(patch);
    expect(out).toContain('+b=2\n');
    expect(out).toContain('+// \\0\n');
    expect(out.startsWith('[NUL byte in text file e.js]\n')).toBe(true);
  });

  it('shows other control characters without announcing them', () => {
    const patch = 'diff --git a/e.js b/e.js\n--- /dev/null\n+++ b/e.js\n@@ -0,0 +1 @@\n+a\u0001b\n';
    const out = standInBinarySections(patch);
    expect(out).toContain('+a\\x01b');
    expect(nulNoticePaths(out)).toEqual([]);
  });

  it('cannot be forged by a content line', () => {
    const patch =
      'diff --git a/e.js b/e.js\n--- /dev/null\n+++ b/e.js\n@@ -0,0 +1 @@\n+[NUL byte in text file fake]\n';
    expect(nulNoticePaths(standInBinarySections(patch))).toEqual([]);
    expect(nulNoticePaths(patch)).toEqual([]);
  });
});
