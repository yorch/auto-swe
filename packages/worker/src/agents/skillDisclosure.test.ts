import { describe, expect, it, vi } from 'vitest';
import type { AgentTracer } from '../lib/agentTracer.js';
import type { ResolvedSkill } from '../lib/config/agentSkills.js';
import { LOAD_SKILL_TOOL, loadSkillWorkerTool, skillMenuSuffix } from './skillDisclosure.js';

const skills = [
  {
    description: 'Test-first delivery.',
    name: 'tdd',
    promptText: 'Write the failing test first.',
  },
  {
    description: '',
    name: 'bare',
    promptText: 'No description of its own.',
  },
] as unknown as ResolvedSkill[];

function tracer(): AgentTracer {
  return { addActivityEvent: vi.fn(), addToolCall: vi.fn() } as unknown as AgentTracer;
}

describe('skillMenuSuffix', () => {
  it('lists names and descriptions only, and points at the tool', () => {
    const menu = skillMenuSuffix(skills);
    expect(menu).toContain('## Available Skills');
    expect(menu).toContain('`loadSkill`');
    expect(menu).toContain('- **tdd**: Test-first delivery.');
    // A skill with no description still gets a line, labelled with its name.
    expect(menu).toContain('- **bare**: bare');
    // The text itself is what `loadSkill` exists to avoid putting in the prompt.
    expect(menu).not.toContain('Write the failing test first.');
  });

  it('is empty with no skills', () => {
    expect(skillMenuSuffix([])).toBe('');
  });

  it('labels an imported skill as third-party, as the Mastra menu does', () => {
    const menu = skillMenuSuffix([
      {
        description: 'Imported.',
        name: 'ext',
        promptText: 'x',
        provenance: 'external: acme/skills@abc1234',
      },
    ] as unknown as ResolvedSkill[]);
    expect(menu).toContain('[external: acme/skills@abc1234] Imported.');
  });
});

describe('loadSkillWorkerTool', () => {
  it('is named loadSkill and describes the menu', () => {
    const tool = loadSkillWorkerTool(skills, tracer());
    expect(tool.name).toBe(LOAD_SKILL_TOOL);
    expect(tool.description).toContain('full guidance text');
  });

  it('returns the requested skill’s full text, traced', async () => {
    const t = tracer();
    const tool = loadSkillWorkerTool(skills, t);

    await expect(tool.call({ name: 'tdd' })).resolves.toEqual({
      promptText: 'Write the failing test first.',
    });
    expect(vi.mocked(t.addToolCall)).toHaveBeenCalledWith(
      expect.objectContaining({ inputJson: { name: 'tdd' }, toolName: 'loadSkill' })
    );
  });

  it('names the skills that do exist when the name is wrong, and traces it too', async () => {
    const t = tracer();
    const tool = loadSkillWorkerTool(skills, t);

    await expect(tool.call({ name: 'nope' })).resolves.toEqual({
      promptText: 'Unknown skill: nope. Available: tdd, bare',
    });
    expect(vi.mocked(t.addToolCall)).toHaveBeenCalledTimes(1);
  });

  it('tells a Pi tool-message renderer to send the text as it is', () => {
    const tool = loadSkillWorkerTool(skills, tracer());
    expect(tool.toText?.({ promptText: '# Skill' })).toBe('# Skill');
  });
});
