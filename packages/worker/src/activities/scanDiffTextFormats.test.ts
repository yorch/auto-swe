/**
 * What counts as text, as binary and as a refusal in the scanned diff, against real git: UTF-16
 * text is decoded and kept whole, files named or headed like binaries become strings, a path on
 * the `workspace.nulAllowedPaths` list is reduced like a binary, and any other NUL byte in a file
 * that is not binary is announced (and so refused by the gate). Every case ends in the post-diff
 * gate itself, because that is where a wrong answer blocks a legitimate commit or lets one through.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentTracer } from '../lib/agentTracer.js';
import { runPostDiffSecurityGate } from '../lib/securityGate.js';
import { commitStaged, diffForResult, startPathGuard } from './allowedPaths.js';
import { isBinaryPath, nulNoticePaths, type StandInOptions } from './scanDiffText.js';

let dir: string;
const sh = (cmd: string): string =>
  execSync(cmd, {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    maxBuffer: 64 * 1024 * 1024,
    shell: '/bin/sh',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
const workspace = { exec: async (cmd: string) => sh(cmd) };
const write = (file: string, data: string | Buffer) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), data);
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'diff-formats-'));
  sh('git init -q -b main && git config user.name t && git config user.email t@t');
  write('README.md', '# base\n');
  sh('git add -A && git commit -q -m base && git update-ref refs/remotes/origin/main HEAD');
});
afterEach(() => rmSync(dir, { force: true, recursive: true }));

async function scanned(options: StandInOptions = {}): Promise<string> {
  const guard = await startPathGuard(workspace, 'main', undefined);
  sh('git add -A');
  const sha = await commitStaged(workspace, 'auto: implement', guard);
  return diffForResult(workspace, guard, sha, options);
}

const tracer = { addActivityEvent() {} } as unknown as AgentTracer;
/** What the gate says about a diff: the files it refused, or the text its model scanner read. */
async function gate(diff: string): Promise<{ blocked: string[]; seen?: string }> {
  let seen: string | undefined;
  try {
    await runPostDiffSecurityGate(diff, tracer, {
      scanDiffForCodeIssues: async () => [],
      scanDiffForSecurityIssues: async (d) => {
        seen = d;
        return { findings: [], passed: true };
      },
    });
    return { blocked: [], seen };
  } catch (err) {
    const findings = (err as { details?: Array<{ findings: Array<{ file: string }> }> })
      .details?.[0]?.findings;
    if (!findings) {
      throw err;
    }
    return { blocked: findings.map((f) => f.file) };
  }
}

const utf16 = (text: string, endian: 'le' | 'be', bom: boolean): Buffer => {
  const le = Buffer.from(text, 'utf16le');
  const body = endian === 'le' ? le : Buffer.from(le).swap16();
  const mark = endian === 'le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff]);
  return bom ? Buffer.concat([mark, body]) : body;
};

describe('UTF-16 text', () => {
  it.each([
    ['LE with a BOM', 'le', true],
    ['BE with a BOM', 'be', true],
    ['LE without a BOM', 'le', false],
    ['BE without a BOM', 'be', false],
  ] as const)('%s is decoded, whole, and not refused', async (_name, endian, bom) => {
    const text = '"hello" = "Hello";\r\n\r\n"bye" = "Goodbye";\n"é" = "e acute";\n';
    write('App/en.lproj/Localizable.strings', utf16(text, endian, bom));
    const diff = await scanned();
    expect(diff).not.toContain('\0');
    expect(nulNoticePaths(diff)).toEqual([]);
    for (const line of ['+"hello" = "Hello";\r', '+\r', '+"bye" = "Goodbye";']) {
      expect(diff).toContain(`${line}\n`);
    }
    expect((await gate(diff)).blocked).toEqual([]);
  });

  it('shows a PowerShell script and a registry file as the text they are', async () => {
    write('scripts/install.ps1', utf16('Write-Host "hi"\r\n', 'le', true));
    write('setup/app.reg', utf16('Windows Registry Editor Version 5.00\r\n', 'le', true));
    const verdict = await gate(await scanned());
    expect(verdict.blocked).toEqual([]);
    expect(verdict.seen).toContain('+Write-Host "hi"');
    expect(verdict.seen).toContain('+Windows Registry Editor Version 5.00');
  });

  it('decodes a change in the middle of a UTF-16 file, context and removed lines included', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `key${i} = "value${i}";`);
    write('a.strings', utf16(`${lines.join('\n')}\n`, 'le', true));
    sh('git add -A && git commit -q -m utf16 && git update-ref refs/remotes/origin/main HEAD');
    lines[15] = 'key15 = "changed";';
    write('a.strings', utf16(`${lines.join('\n')}\n`, 'le', true));
    const diff = await scanned();
    expect(diff).not.toContain('\0');
    expect(diff).toContain('-key15 = "value15";\n');
    expect(diff).toContain('+key15 = "changed";\n');
    expect(diff).toContain(' key14 = "value14";\n');
    expect((await gate(diff)).blocked).toEqual([]);
  });

  it('still refuses a NUL character inside UTF-16 text', async () => {
    write('a.strings', utf16('one\n\0two\n', 'le', true));
    expect((await gate(await scanned())).blocked).toEqual(['a.strings']);
  });

  it('is no way to hide an ASCII source file behind a byte order mark', async () => {
    write(
      'evil.js',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('const a=1;\0\neval(x)\n')])
    );
    const diff = await scanned();
    expect(nulNoticePaths(diff)).toEqual(['evil.js']);
    expect((await gate(diff)).blocked).toEqual(['evil.js']);
  });

  it('is no way to hide half-ASCII text next to real UTF-16', async () => {
    write('mixed.txt', Buffer.concat([utf16('visible\n', 'le', true), Buffer.from('cu=rl\n')]));
    expect((await gate(await scanned())).blocked).toEqual(['mixed.txt']);
  });
});

describe('binary by name', () => {
  it.each([
    'bun.lockb',
    'models/m.onnx',
    'bin/app.pdb',
    'data/x.pkl',
    'data/x.pickle',
    'android/debug.keystore',
    'ca/store.jks',
    'cert.p12',
    'cert.pfx',
    'cert.der',
    'weights/m.safetensors',
    'weights/m.gguf',
    'weights/m.pt',
    'weights/m.h5',
    'weights/a.npy',
    'weights/a.npz',
    'm.tflite',
    'app/Icon.icns',
    'art/a.psd',
    'art/a.glb',
    'art/a.blend',
    'inst/a.msi',
    'pkg/a.nupkg',
    'a/a.aar',
    'a/a.war',
    'a/a.ear',
    'a/a.beam',
    'a/a.pyo',
    'a/a.rlib',
    'a/a.mdb',
    'f/a.ttc',
    'f/a.tga',
    'f/a.dds',
    'f/a.exr',
    'f/a.ktx',
    'f/a.aac',
    'f/a.mid',
    'f/a.swf',
    'Sources/.DS_Store',
  ])('%s with a NUL is a stand-in, not a refusal', async (name) => {
    expect(isBinaryPath(name)).toBe(true);
    write(name, Buffer.from('\x08\x07\x12\x07header-string-here\0\0\x1a'));
    const diff = await scanned();
    expect(diff).toContain(`Binary content of ${name}`);
    expect((await gate(diff)).blocked).toEqual([]);
  });

  it('reads the path of a file whose name git quotes (quote, backslash, tab)', async () => {
    for (const name of ['we"ird.png', 'back\\slash.png', 'tab\tname.png', 'b/ in a b/name.png']) {
      write(name, Buffer.from('\x89PNG\0\0 an-embedded-string \0\0'));
    }
    write('we"ird.js', 'a\0b\n');
    const diff = await scanned();
    expect(nulNoticePaths(diff)).toEqual(['we"ird.js']);
    for (const name of ['we"ird.png', 'back\\slash.png', 'tab\tname.png', 'b/ in a b/name.png']) {
      expect(diff).toContain(`Binary content of ${name} (`);
    }
    expect((await gate(diff)).blocked).toEqual(['we"ird.js']);
  });

  it('reads the new path of a renamed binary', async () => {
    write('old.dat', Buffer.from('\x89PNG\0\0 an-embedded-string \0\0'));
    sh('git add -A && git commit -q -m old && git update-ref refs/remotes/origin/main HEAD');
    sh('git mv old.dat new.png');
    expect(await scanned()).not.toContain('NUL byte in text file');
  });
});

describe('binary by content', () => {
  const MZ = Buffer.concat([
    Buffer.from('MZ'),
    Buffer.alloc(0x3a),
    Buffer.from('\x80\0\0\0PE\0\0L\x01'),
  ]);
  it.each([
    ['ELF', 'tools/protoc', Buffer.from('\x7fELF\x02\x01\x01\0\0\0')],
    ['Mach-O 64', 'tools/mach', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0, 0, 1, 0])],
    ['Mach-O 32', 'tools/mach32', Buffer.from([0xfe, 0xed, 0xfa, 0xce, 0, 0, 0, 7, 0])],
    ['fat Mach-O or class', 'tools/fat', Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2, 0])],
    ['PE', 'tools/winexe', MZ],
    ['wasm', 'tools/mod', Buffer.from('\0asm\x01\0\0\0\0')],
    ['zip', 'tools/bundle', Buffer.from('PK\x03\x04\x14\0\0\0 stored-file-name \0')],
    ['gzip', 'tools/tarball', Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3])],
  ])('an extension-less %s is a stand-in, not a refusal', async (_name, file, bytes) => {
    write(file, bytes);
    const diff = await scanned();
    expect(diff).toContain(`Binary content of ${file}`);
    expect(nulNoticePaths(diff)).toEqual([]);
    expect((await gate(diff)).blocked).toEqual([]);
  });

  it('does not let a source file shed its lines by starting with an ELF header', async () => {
    write('evil.js', Buffer.from('\x7fELF\neval(x)\n\0\n'));
    write('Makefile', Buffer.from('\x7fELF\neval(x)\n\0\n'));
    const diff = await scanned();
    // A name that claims to be text keeps every line; an extension-less one is judged by content.
    expect(diff).toContain('+eval(x)');
    expect(nulNoticePaths(diff)).toEqual(['evil.js']);
  });

  it('refuses a NUL in an extension-less text file', async () => {
    write('tools/script', 'echo hi\0\nevil\n');
    expect((await gate(await scanned())).blocked).toEqual(['tools/script']);
  });

  it('does not take a script that merely starts with MZ for an executable', async () => {
    write('tools/mz', 'MZ=1\0\nevil\n');
    expect((await gate(await scanned())).blocked).toEqual(['tools/mz']);
  });
});

describe('workspace.nulAllowedPaths', () => {
  const options = { nulAllowedPaths: ['test/fixtures/**', '**/*.fixture'] };

  it('control: a fixture holding a NUL is refused without the setting', async () => {
    write('test/fixtures/nul.txt', 'a\0b\n');
    expect((await gate(await scanned())).blocked).toEqual(['test/fixtures/nul.txt']);
  });

  it('reduces a matching file to its strings instead of refusing it', async () => {
    write('test/fixtures/nul.txt', 'a\0b\nsome long printable line\n');
    write('data/x.fixture', 'a\0b\n');
    const diff = await scanned(options);
    expect(diff).toContain('Binary content of test/fixtures/nul.txt');
    expect(diff).toContain('some long printable line');
    expect(diff).not.toContain('\0');
    expect((await gate(diff)).blocked).toEqual([]);
  });

  it('refuses a NUL in a file the list does not match', async () => {
    write('src/other.txt', 'a\0b\n');
    write('Test/Fixtures/ok.txt', 'a\0b\n');
    expect((await gate(await scanned(options))).blocked).toEqual(['src/other.txt']);
  });
});
