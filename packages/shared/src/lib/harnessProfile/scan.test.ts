import { describe, expect, it, vi } from 'vitest';
import { scanProfile } from './scan.js';
import type { ProfileScanners } from './scanners.js';
import { file, validFiles } from './testing.js';
import { validateProfile } from './validate.js';

function scanners(over: Partial<{ text: string[]; shell: string[]; incomplete: boolean }> = {}) {
  const calls = { shell: [] as string[], text: [] as string[] };
  const s: ProfileScanners = {
    shell: vi.fn(async (c) => {
      calls.shell.push(c);
      return { hits: over.shell ?? [], incomplete: over.incomplete ?? false };
    }),
    text: vi.fn(async (t) => {
      calls.text.push(t);
      return { hits: over.text ?? [], incomplete: over.incomplete ?? false };
    }),
  };
  return { calls, s };
}

async function run(files = validFiles(), s: ProfileScanners) {
  const v = validateProfile(files);
  if (!v.ok) {
    throw new Error(v.errors.join());
  }
  return scanProfile(files, v.manifest, v.pluginDirs, s);
}

describe('scanProfile', () => {
  it('scans the instructions and plugin markdown with the text scanner, nothing else', async () => {
    const { calls, s } = scanners();
    const files = [...validFiles(), file('misc/notes.md', 'unused prose')];
    expect(await run(files, s)).toEqual([]);
    expect(calls.text.sort()).toEqual(['# Be careful\n', 'Say hello']);
    expect(calls.shell).toEqual([]);
  });

  it('reports text hits with the file and pattern', async () => {
    const { s } = scanners({ text: ['injection:override'] });
    const warnings = await run(validFiles(), s);
    expect(warnings).toContain('INSTRUCTIONS.md: text pattern injection:override');
    expect(warnings).toContain('plugins/foo/commands/hello.md: text pattern injection:override');
  });

  it('scans every hook command in hooks.json and inline plugin hooks', async () => {
    const { calls, s } = scanners({ shell: ['shell:curl-upload'] });
    const files = validFiles();
    files[2] = file(
      'plugins/foo/.claude-plugin/plugin.json',
      JSON.stringify({
        hooks: { PreToolUse: [{ hooks: [{ command: 'inline-cmd', type: 'command' }] }] },
        name: 'foo',
      })
    );
    files.push(
      file(
        'plugins/foo/hooks/hooks.json',
        JSON.stringify({
          hooks: {
            PostToolUse: [
              { hooks: [{ command: 'echo one', type: 'command' }, { command: 'echo two' }] },
            ],
          },
        })
      )
    );
    const warnings = await run(files, s);
    expect(calls.shell.sort()).toEqual(['echo one', 'echo two', 'inline-cmd']);
    expect(warnings).toContain(
      'plugins/foo/hooks/hooks.json (hook command): shell pattern shell:curl-upload'
    );
  });

  it('scans scripts and executable files as shell, and flags binary ones', async () => {
    const { calls, s } = scanners();
    const files = [
      ...validFiles(),
      file('plugins/foo/scripts/a.sh', 'rm -rf /'),
      file('plugins/foo/bin/run', 'echo hi', '100755'),
      {
        bytes: Buffer.from([0xff, 0xfe, 0x00]),
        mode: '100755' as const,
        path: 'plugins/foo/bin/blob',
      },
    ];
    const warnings = await run(files, s);
    expect(calls.shell.sort()).toEqual(['echo hi', 'rm -rf /']);
    expect(warnings).toContain('plugins/foo/bin/blob: binary content, not scanned');
  });

  it('reports invalid hooks.json and invalid UTF-8 prose instead of skipping silently', async () => {
    const { s } = scanners();
    const files = [
      ...validFiles(),
      file('plugins/foo/hooks/hooks.json', '{nope'),
      { bytes: Buffer.from([0xff]), mode: '100644' as const, path: 'plugins/foo/skills/x.md' },
    ];
    const warnings = await run(files, s);
    expect(warnings).toContain(
      'plugins/foo/hooks/hooks.json: not valid JSON, hook commands not scanned'
    );
    expect(warnings).toContain('plugins/foo/skills/x.md: not valid UTF-8 text, not scanned');
  });

  it('scans hooks files named by path in plugin.json and reports the ones it cannot read', async () => {
    const { calls, s } = scanners();
    const files = validFiles();
    files[2] = file(
      'plugins/foo/.claude-plugin/plugin.json',
      JSON.stringify({
        hooks: [
          './hooks/a.json',
          ['$', '{CLAUDE_PLUGIN_ROOT}/hooks/b.json'].join(''),
          '../outside.json',
          './hooks/missing.json',
          './hooks/bad.json',
          { PreToolUse: [{ hooks: [{ command: 'inline-cmd' }] }] },
        ],
        name: 'foo',
      })
    );
    files.push(
      file('plugins/foo/hooks/a.json', JSON.stringify({ hooks: [{ command: 'from-a' }] })),
      file('plugins/foo/hooks/b.json', JSON.stringify({ hooks: [{ command: 'from-b' }] })),
      file('plugins/foo/hooks/bad.json', '{nope')
    );
    const warnings = await run(files, s);
    expect(calls.shell.sort()).toEqual(['from-a', 'from-b', 'inline-cmd']);
    expect(warnings).toContain(
      'plugins/foo/.claude-plugin/plugin.json: hooks-not-scanned: a hooks path points outside the plugin folder'
    );
    expect(warnings).toContain(
      'plugins/foo/.claude-plugin/plugin.json: hooks-not-scanned: hooks file plugins/foo/hooks/missing.json is missing'
    );
    expect(warnings).toContain(
      'plugins/foo/hooks/bad.json: hooks-not-scanned: the hooks file is not valid UTF-8 JSON'
    );
  });

  it('scans a hooks file once when plugin.json names the default hooks/hooks.json', async () => {
    const { calls, s } = scanners();
    const files = validFiles();
    files[2] = file(
      'plugins/foo/.claude-plugin/plugin.json',
      JSON.stringify({ hooks: './hooks/hooks.json', name: 'foo' })
    );
    files.push(
      file('plugins/foo/hooks/hooks.json', JSON.stringify({ hooks: [{ command: 'once' }] }))
    );
    await run(files, s);
    expect(calls.shell).toEqual(['once']);
  });

  it('scans an extension-less file that starts with a shebang as a script', async () => {
    const { calls, s } = scanners();
    const files = [
      ...validFiles(),
      file('plugins/foo/bin/runner', '#!/usr/bin/env bash\necho hi\n'),
      file('plugins/foo/bin/readme', 'no shebang here'),
    ];
    await run(files, s);
    expect(calls.shell).toEqual(['#!/usr/bin/env bash\necho hi\n']);
  });

  it('never reports an incomplete scan as clean', async () => {
    const { s } = scanners({ incomplete: true });
    const warnings = await run(validFiles(), s);
    expect(warnings.some((w) => w.includes('scan-incomplete'))).toBe(true);
  });

  it('strips control characters from names in warnings', async () => {
    const { s } = scanners({ text: ['injection:\u001b[31mred'] });
    const warnings = await run(validFiles(), s);
    expect(warnings.join('')).not.toContain('\u001b');
  });
});
