import type { ProfileFile } from '@auto-swe/shared/lib/harnessProfile';
import { describe, expect, it } from 'vitest';
import { hasHookChanges, hookChangesBetween, pluginNamesOf } from './pluginSnapshot.js';

const f = (path: string, text: string): ProfileFile => ({
  bytes: Buffer.from(text),
  mode: '100644',
  path,
});
const hooksDoc = (command: string) =>
  JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command, type: 'command' }] }] } });
const manifest = { plugins: ['plugins/a'] };

describe('pluginNamesOf', () => {
  it('reads plugin.json names, falls back to the directory, lower-cases', () => {
    const files = [
      f('plugins/a/.claude-plugin/plugin.json', '{"name":"Alpha"}'),
      f('plugins/b/.claude-plugin/plugin.json', '{}'),
      f('plugins/c/.claude-plugin/plugin.json', 'not json'),
    ];
    expect(pluginNamesOf(files, { plugins: ['plugins/a', './plugins/b/', 'plugins/c'] })).toEqual([
      'alpha',
      'b',
      'c',
    ]);
  });
});

describe('hookChangesBetween', () => {
  const plugin = (extra: ProfileFile[] = [], json = '{"name":"a"}') => ({
    files: [f('plugins/a/.claude-plugin/plugin.json', json), ...extra],
    manifest,
  });

  it('reports nothing when no hook file moved', () => {
    const prev = plugin([f('plugins/a/hooks/hooks.json', hooksDoc('x')), f('plugins/a/x.md', '1')]);
    const next = plugin([f('plugins/a/hooks/hooks.json', hooksDoc('x')), f('plugins/a/x.md', '2')]);
    expect(hasHookChanges(hookChangesBetween(prev, next))).toBe(false);
  });

  it('reports added, removed and changed hook files with their commands', () => {
    const prev = plugin([f('plugins/a/hooks/hooks.json', hooksDoc('echo one'))]);
    const changed = plugin([f('plugins/a/hooks/hooks.json', hooksDoc('echo two'))]);
    expect(hookChangesBetween(prev, changed).changed).toEqual([
      {
        addedCommands: ['echo two'],
        path: 'plugins/a/hooks/hooks.json',
        removedCommands: ['echo one'],
      },
    ]);
    const none = plugin();
    expect(hookChangesBetween(prev, none).removed).toEqual([
      { commands: ['echo one'], path: 'plugins/a/hooks/hooks.json' },
    ]);
    expect(hookChangesBetween(none, prev).added).toEqual([
      { commands: ['echo one'], path: 'plugins/a/hooks/hooks.json' },
    ]);
  });

  it('sees inline hooks and files named by plugin.json', () => {
    const inline = (command: string) =>
      plugin([], JSON.stringify({ hooks: JSON.parse(hooksDoc(command)).hooks, name: 'a' }));
    const diff = hookChangesBetween(inline('a'), inline('b'));
    expect(diff.changed).toEqual([
      {
        addedCommands: ['b'],
        path: 'plugins/a/.claude-plugin/plugin.json#hooks',
        removedCommands: ['a'],
      },
    ]);
    const named = (command: string) =>
      plugin(
        [f('plugins/a/hooks/extra.json', hooksDoc(command))],
        '{"name":"a","hooks":"./hooks/extra.json"}'
      );
    expect(hookChangesBetween(named('a'), named('b')).changed[0]?.path).toBe(
      'plugins/a/hooks/extra.json'
    );
    // A named file that leaves the plugin folder still counts as a hook source.
    const escaping = plugin([], '{"name":"a","hooks":"../../x.json"}');
    expect(hookChangesBetween(plugin(), escaping).added).toHaveLength(1);
  });

  it('shows a frontmatter hook an update adds, removes and changes', () => {
    const md = (command: string) =>
      `---\nname: x\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: ${command}\n---\nbody`;
    const skill = 'plugins/a/skills/x/SKILL.md';
    const clean = plugin([f(skill, '---\nname: x\n---\nbody')]);
    const hooked = plugin([f(skill, md('curl evil'))]);
    const added = hookChangesBetween(clean, hooked);
    expect(added.added).toEqual([{ commands: ['curl evil'], path: `${skill}#hooks` }]);
    expect(hasHookChanges(added)).toBe(true);
    expect(hookChangesBetween(hooked, clean).removed).toHaveLength(1);
    expect(hookChangesBetween(hooked, plugin([f(skill, md('echo ok'))])).changed).toEqual([
      { addedCommands: ['echo ok'], path: `${skill}#hooks`, removedCommands: ['curl evil'] },
    ]);
  });

  it('shows monitors and LSP servers an update adds', () => {
    const next = plugin([
      f('plugins/a/monitors/monitors.json', '[{"command":"watch","args":["x"]}]'),
      f('plugins/a/.lsp.json', '{"go":{"command":"gopls"}}'),
    ]);
    const changes = hookChangesBetween(plugin(), next);
    expect(changes.added).toEqual([
      { commands: ['gopls'], path: 'plugins/a/.lsp.json' },
      { commands: ['watch x'], path: 'plugins/a/monitors/monitors.json' },
    ]);
    const inline = plugin(
      [],
      '{"name":"a","lspServers":{"x":{"command":"srv"}},"monitors":[{"command":"m"}]}'
    );
    expect(hookChangesBetween(plugin(), inline).added.map((a) => a.path)).toEqual([
      'plugins/a/.claude-plugin/plugin.json#lspServers',
      'plugins/a/.claude-plugin/plugin.json#monitors',
    ]);
  });
});
