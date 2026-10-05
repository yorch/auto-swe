import { describe, expect, it } from 'vitest';
import { missingCredentialProvider, modelLabel } from './agentDisplay';

describe('modelLabel', () => {
  it('prefers the agent’s own model spec', () => {
    expect(modelLabel({ inheritsModelFrom: 'reviewer', modelSpec: 'anthropic/x' })).toBe(
      'anthropic/x'
    );
  });
  it('names the agent a model is inherited from', () => {
    expect(modelLabel({ inheritsModelFrom: 'reviewer', modelSpec: null })).toBe(
      '↳ inherits reviewer'
    );
  });
  it('falls back to the role default', () => {
    expect(modelLabel({ inheritsModelFrom: null, modelSpec: null })).toBe('— (role default)');
  });
});

describe('missingCredentialProvider', () => {
  const providers = [
    { present: false, provider: 'openai', usedBy: ['planner', 'decomposer'] },
    { present: true, provider: 'anthropic', usedBy: ['reviewer'] },
  ];
  const planner = {
    credentialId: null,
    inheritsModelFrom: null,
    isActive: true,
    key: 'planner',
    modelSpec: 'openai/gpt-6.1-sol',
    scope: 'GLOBAL' as const,
  };
  const reviewer = { ...planner, key: 'reviewer', modelSpec: 'anthropic/claude-opus-5-5' };
  const agents = [planner, reviewer];

  it('flags an agent whose provider has no credential', () => {
    expect(missingCredentialProvider(planner, agents, providers)).toBe('openai');
  });
  it('does not flag an agent whose provider is covered', () => {
    expect(missingCredentialProvider(reviewer, agents, providers)).toBeNull();
  });
  it('does not flag an agent pinned to its own credential', () => {
    expect(missingCredentialProvider({ ...planner, credentialId: 'c1' }, agents, providers)).toBe(
      null
    );
  });
  it('gives a sub-role persona its parent’s status', () => {
    const persona = { credentialId: null, inheritsModelFrom: 'planner', modelSpec: null };
    expect(missingCredentialProvider(persona, agents, providers)).toBe('openai');
    expect(
      missingCredentialProvider({ ...persona, inheritsModelFrom: 'reviewer' }, agents, providers)
    ).toBeNull();
  });
  it('says nothing while readiness has not loaded', () => {
    expect(missingCredentialProvider(planner, agents, [])).toBeNull();
  });
});
