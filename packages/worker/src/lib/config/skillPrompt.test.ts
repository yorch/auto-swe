import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./agentResolver.js', () => ({ fetchActiveAgent: vi.fn(), skillsFromAgent: vi.fn() }));

import { skillsToPromptSuffix } from './agentSkills.js';
import { joinSkillPrompts, skillMenuLine, skillPromptBlock } from './skillPrompt.js';

const plain = { description: 'd', name: 'plain', promptText: 'PLAIN TEXT' };
const imported = {
  description: 'Reviews',
  name: 'ext',
  promptText: 'IMPORTED TEXT',
  provenance: 'external: acme/skills@0123456',
};

describe('skillPromptBlock', () => {
  it('leaves authored text alone and labels imported text as third-party', () => {
    expect(skillPromptBlock(plain)).toBe('PLAIN TEXT');
    expect(skillPromptBlock(imported)).toBe(
      '[external: acme/skills@0123456 — third-party text]\nIMPORTED TEXT'
    );
  });

  it('joins blocks, skipping skills with no text', () => {
    expect(joinSkillPrompts([plain, { ...plain, promptText: '' }, imported])).toBe(
      'PLAIN TEXT\n\n[external: acme/skills@0123456 — third-party text]\nIMPORTED TEXT'
    );
    expect(joinSkillPrompts([])).toBe('');
  });

  it('labels the menu entry', () => {
    expect(skillMenuLine(imported)).toBe('- **ext**: [external: acme/skills@0123456] Reviews');
  });

  it('skillsToPromptSuffix (harness, review personas, runAgent) carries the label', () => {
    const suffix = skillsToPromptSuffix([plain, imported] as never);
    expect(suffix).toContain('[external: acme/skills@0123456 — third-party text]');
    expect(skillsToPromptSuffix([] as never)).toBeUndefined();
  });
});

/**
 * Every route a skill's text takes to a model must go through skillPrompt.ts so
 * the provenance label cannot be forgotten: a new `.promptText` read outside it
 * fails here. Add a file to ALLOWED only if it reads something that is not a
 * resolved skill (and say why).
 */
describe('skill text reaches a model only through skillPrompt.ts', () => {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const ALLOWED = new Set([
    // Builds the ResolvedSkill (and the pinned-revision select) the helpers read.
    'lib/config/agentResolver.ts',
    // The ResolvedSkill type.
    'lib/config/types.ts',
    // The helpers themselves.
    'lib/config/skillPrompt.ts',
    // An eval rubric's prompt, not a skill.
    'activities/runEvalNode.ts',
  ]);

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        return walk(p);
      }
      return p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts') ? [p] : [];
    });

  it('has no other `.promptText` read in the worker', () => {
    const offenders = walk(SRC)
      .map((p) => relative(SRC, p))
      .filter((rel) => !ALLOWED.has(rel))
      .flatMap((rel) =>
        readFileSync(join(SRC, rel), 'utf8')
          .split('\n')
          .flatMap((line, i) =>
            /\.promptText\b/.test(line) && !line.trim().startsWith('//') ? [`${rel}:${i + 1}`] : []
          )
      );
    expect(offenders).toEqual([]);
  });
});
