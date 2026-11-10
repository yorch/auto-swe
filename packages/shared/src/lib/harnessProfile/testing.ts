import type { ProfileFile, ProfileFileMode } from './types.js';

/** Test helper: a file from text. Not exported from the package index. */
export const file = (
  path: string,
  text: string,
  mode: ProfileFileMode = '100644'
): ProfileFile => ({
  bytes: Buffer.from(text),
  mode,
  path,
});

export const manifestFile = (over: Record<string, unknown> = {}) =>
  file(
    'profile.json',
    JSON.stringify({
      description: 'A profile',
      instructions: 'INSTRUCTIONS.md',
      name: 'demo',
      ...over,
    })
  );

/** A minimal valid profile with one plugin. */
export const validFiles = (): ProfileFile[] => [
  manifestFile({ plugins: ['plugins/foo'], tools: ['Skill'] }),
  file('INSTRUCTIONS.md', '# Be careful\n'),
  file('plugins/foo/.claude-plugin/plugin.json', '{"name":"foo"}'),
  file('plugins/foo/commands/hello.md', 'Say hello'),
];
