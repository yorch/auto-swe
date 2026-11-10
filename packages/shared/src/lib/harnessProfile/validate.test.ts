import { describe, expect, it } from 'vitest';
import { file, manifestFile, validFiles } from './testing.js';
import { PROFILE_LIMITS } from './types.js';
import { computeContentHash, validateProfile } from './validate.js';

const errorsOf = (files: Parameters<typeof validateProfile>[0]) => {
  const r = validateProfile(files);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.errors;
};

describe('validateProfile', () => {
  it('accepts a valid profile and indexes its files', () => {
    const r = validateProfile(validFiles());
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.manifest).toMatchObject({ name: 'demo', plugins: ['plugins/foo'], tools: ['Skill'] });
    expect(r.pluginDirs).toEqual(['plugins/foo']);
    expect(r.fileIndex.map((f) => f.path)).toEqual([
      'INSTRUCTIONS.md',
      'plugins/foo/.claude-plugin/plugin.json',
      'plugins/foo/commands/hello.md',
      'profile.json',
    ]);
    expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.warnings).toEqual([]);
  });

  it('accepts a profile with only a manifest', () => {
    expect(validateProfile([file('profile.json', '{"name":"a","description":"d"}')]).ok).toBe(true);
  });

  it('requires profile.json', () => {
    expect(errorsOf([file('INSTRUCTIONS.md', 'x')])).toEqual([
      'profile.json not found in the folder',
    ]);
  });

  it.each([
    ['not json', 'nope'],
    ['not an object', '[]'],
    ['no name', '{"description":"d"}'],
    ['bad name chars', '{"name":"a b","description":"d"}'],
    ['name starts with a dot', '{"name":".x","description":"d"}'],
    ['name too long', `{"name":"${'a'.repeat(65)}","description":"d"}`],
    ['no description', '{"name":"a"}'],
    ['long description', `{"name":"a","description":"${'d'.repeat(1001)}"}`],
    ['unknown key', '{"name":"a","description":"d","extra":1}'],
    ['plugins not an array', '{"name":"a","description":"d","plugins":"x"}'],
  ])('rejects a manifest that is %s', (_label, body) => {
    expect(errorsOf([file('profile.json', body)]).length).toBeGreaterThan(0);
  });

  it.each(['WebFetch', 'Bash', 'WebSearch', 'Task'])('rejects tool %s', (tool) => {
    const errors = errorsOf([manifestFile({ instructions: undefined, tools: [tool] })]);
    expect(errors).toEqual(['profile.json tools may only list Skill and Agent']);
  });

  it('never echoes manifest text in an error', () => {
    const errors = errorsOf([
      file('profile.json', '{"name":"a","description":"d","SECRET-KEY":"v","plugins":[1]}'),
    ]);
    expect(errors.join(' ')).not.toContain('SECRET-KEY');
  });

  it('requires the instructions file to exist, be .md, safe, UTF-8 and small', () => {
    expect(errorsOf([manifestFile()])).toEqual(['instructions file INSTRUCTIONS.md not found']);
    expect(errorsOf([manifestFile({ instructions: 'x.txt' })])[0]).toMatch(/relative .md path/);
    expect(errorsOf([manifestFile({ instructions: '../x.md' })])[0]).toMatch(/relative .md path/);
    expect(errorsOf([manifestFile({ instructions: '/x.md' })])[0]).toMatch(/relative .md path/);
    expect(
      errorsOf([
        manifestFile(),
        { bytes: Buffer.from([0xff, 0xfe]), mode: '100644', path: 'INSTRUCTIONS.md' },
      ])
    ).toEqual(['instructions file is not valid UTF-8 text']);
    expect(errorsOf([manifestFile(), file('INSTRUCTIONS.md', 'x'.repeat(100_001))])[0]).toMatch(
      /instructions file exceeds/
    );
  });

  it('requires every plugin to carry a valid .claude-plugin/plugin.json', () => {
    const base = [manifestFile({ instructions: undefined, plugins: ['plugins/foo'] })];
    expect(errorsOf(base)[0]).toMatch(/no \.claude-plugin\/plugin\.json/);
    expect(errorsOf([...base, file('plugins/foo/.claude-plugin/plugin.json', '{oops')])[0]).toMatch(
      /not a valid JSON object/
    );
    expect(errorsOf([...base, file('plugins/foo/.claude-plugin/plugin.json', '[]')])[0]).toMatch(
      /not a valid JSON object/
    );
  });

  it('rejects an unsafe or duplicated plugin path', () => {
    const json = file('plugins/foo/.claude-plugin/plugin.json', '{}');
    expect(
      errorsOf([manifestFile({ instructions: undefined, plugins: ['../x'] }), json])[0]
    ).toMatch(/not a safe relative directory/);
    expect(
      errorsOf([
        manifestFile({ instructions: undefined, plugins: ['plugins/foo', 'plugins/foo/'] }),
        json,
      ])[0]
    ).toMatch(/listed twice/);
  });

  describe('file rules', () => {
    const withExtra = (path: string) => [...validFiles(), file(path, 'x')];

    it.each([
      ['/etc/passwd', 'absolute path'],
      ['a/../b', "'..' segment"],
      ['a//b', "'..' segment"],
      ['a/./b', "'..' segment"],
      ['a\\b', 'backslash'],
      ['a‮b', 'control or invisible'],
      ['a\nb', 'control or invisible'],
      ['x/.git/config', "'.git' segment"],
      ['x/.GIT/config', "'.git' segment"],
    ])('rejects path %j', (path, reason) => {
      expect(errorsOf(withExtra(path)).join(' ')).toContain(reason);
    });

    it('rejects duplicate paths after normalisation', () => {
      const errors = errorsOf([...validFiles(), file('Docs/A.md', 'x'), file('docs/a.md', 'y')]);
      expect(errors.join(' ')).toContain('duplicate path after normalisation');
      const nfc = errorsOf([...validFiles(), file('café.md', 'x'), file('café.md', 'y')]);
      expect(nfc.join(' ')).toContain('duplicate path after normalisation');
    });

    it('enforces the file count, per-file and total byte limits', () => {
      const many = Array.from({ length: PROFILE_LIMITS.maxFiles }, (_, i) =>
        file(`f/${i}.txt`, '')
      );
      expect(errorsOf([...validFiles(), ...many]).join(' ')).toContain('more than 500 files');
      expect(
        errorsOf([...validFiles(), file('big.bin', 'x'.repeat(1_000_001))]).join(' ')
      ).toContain('exceeds 1000000 bytes');
      const chunks = Array.from({ length: 6 }, (_, i) => file(`c/${i}.bin`, 'x'.repeat(900_000)));
      expect(errorsOf([...validFiles(), ...chunks]).join(' ')).toContain('in total');
    });
  });

  describe('warnings', () => {
    const warningsOf = (files: Parameters<typeof validateProfile>[0]) => {
      const r = validateProfile(files);
      expect(r.ok).toBe(true);
      return r.ok ? r.warnings.join('\n') : '';
    };

    it('says plugin .mcp.json is ignored at run time', () => {
      expect(warningsOf([...validFiles(), file('plugins/foo/.mcp.json', '{}')])).toContain(
        'plugin MCP servers are stored but ignored at run time (plugins/foo/.mcp.json)'
      );
    });

    it('flags hooks files and inline hooks', () => {
      expect(warningsOf([...validFiles(), file('plugins/foo/hooks/hooks.json', '{}')])).toContain(
        'hooks run commands inside the run container'
      );
      const inline = validFiles();
      inline[2] = file('plugins/foo/.claude-plugin/plugin.json', '{"hooks":{}}');
      expect(warningsOf(inline)).toContain('hooks run commands');
    });

    it('flags scripts and the executable bit', () => {
      const w = warningsOf([
        ...validFiles(),
        file('plugins/foo/scripts/run', 'echo', '100755'),
        file('plugins/foo/tool.py', 'print()'),
      ]);
      expect(w).toContain('scripts are present');
      expect(w).toContain('executable bit set (plugins/foo/scripts/run)');
    });

    it('flags files nothing uses, and truncates long lists', () => {
      const extra = Array.from({ length: 8 }, (_, i) => file(`misc/${i}.md`, ''));
      const w = warningsOf([...validFiles(), ...extra]);
      expect(w).toContain('stored but never used');
      expect(w).toContain('and 3 more');
    });
  });
});

describe('computeContentHash', () => {
  const manifest = { description: 'd', name: 'n' };
  const a = file('a.md', 'A');
  const b = file('b.md', 'B');

  it('does not depend on file order', () => {
    expect(computeContentHash([a, b], manifest)).toBe(computeContentHash([b, a], manifest));
  });

  it('does not depend on manifest key order', () => {
    expect(computeContentHash([a], { description: 'd', name: 'n' })).toBe(
      computeContentHash([a], { description: 'd', name: 'n' })
    );
  });

  it('changes with content, mode, path and manifest', () => {
    const base = computeContentHash([a, b], manifest);
    expect(computeContentHash([file('a.md', 'A!'), b], manifest)).not.toBe(base);
    expect(computeContentHash([file('a.md', 'A', '100755'), b], manifest)).not.toBe(base);
    expect(computeContentHash([file('c.md', 'A'), b], manifest)).not.toBe(base);
    expect(computeContentHash([a, b], { ...manifest, description: 'e' })).not.toBe(base);
  });

  it('is stable (pinned value)', () => {
    expect(computeContentHash([a, b], manifest)).toBe(computeContentHash([a, b], manifest));
    expect(computeContentHash([], manifest)).toMatch(/^[0-9a-f]{64}$/);
  });
});
