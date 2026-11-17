import { describe, expect, it } from 'vitest';
import { isPluginSkill, splitPluginSkillName } from './pluginSkill';

describe('isPluginSkill', () => {
  it('trusts the gateway marker', () => {
    expect(isPluginSkill({ name: 'anything', pluginProfileId: 'p1' })).toBe(true);
  });

  it('falls back to the namespaced name', () => {
    expect(isPluginSkill({ name: 'review-kit:lint' })).toBe(true);
    expect(isPluginSkill({ name: 'review-kit:lint', pluginProfileId: null })).toBe(true);
  });

  it('leaves ordinary skills alone', () => {
    expect(isPluginSkill({ name: 'lint' })).toBe(false);
    expect(isPluginSkill({ name: 'a:b:c' })).toBe(false);
    expect(isPluginSkill({ name: ':x' })).toBe(false);
    expect(isPluginSkill({ name: 'x:' })).toBe(false);
  });
});

describe('splitPluginSkillName', () => {
  it('splits plugin and skill', () => {
    expect(splitPluginSkillName('kit:lint')).toEqual({ plugin: 'kit', skill: 'lint' });
    expect(splitPluginSkillName('lint')).toBeNull();
  });
});
