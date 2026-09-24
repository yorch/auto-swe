import { describe, expect, it } from 'vitest';
import { modelLabel } from './agentDisplay';

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
