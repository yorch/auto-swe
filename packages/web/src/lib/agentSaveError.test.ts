import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import { describeAgentSaveError, isProfileSaveError } from './agentSaveError';

describe('describeAgentSaveError', () => {
  it.each([
    ['PROFILE_DUPLICATE', 'A plugin is listed more than once'],
    ['PROFILE_NAME_COLLISION', 'Two plugins hold a plugin of the same name'],
    ['PROFILE_NOT_ENABLED', 'A plugin is not enabled for this team'],
    ['PROFILE_NOT_FOUND', 'A bound plugin does not exist'],
    ['PROFILE_DISABLED', 'A bound plugin is disabled'],
    ['PROFILE_RUNTIME_MISMATCH', 'Plugins need the Claude Code runtime'],
  ])('titles %s', (code, title) => {
    const err = new ApiError('server sentence', 400, code);
    expect(isProfileSaveError(err)).toBe(true);
    expect(describeAgentSaveError(err, 'x')).toContain(title);
    expect(describeAgentSaveError(err, 'x')).toContain('server sentence');
  });

  it('keeps the missing plugins the server named and says who enables them', () => {
    const err = new ApiError(
      "Not enabled for this team: 'kit-a', 'kit-b'.",
      400,
      'PROFILE_NOT_ENABLED'
    );
    const text = describeAgentSaveError(err, 'x');
    expect(text).toContain("'kit-a', 'kit-b'");
    expect(text).toMatch(/team admin enables it/);
  });

  it('makes hidden characters in the server sentence visible', () => {
    const err = new ApiError('plugin ev‮il', 400, 'PROFILE_NOT_FOUND');
    expect(describeAgentSaveError(err, 'x')).toContain('ev⟨U+202E⟩il');
  });

  it('passes any other error through', () => {
    expect(describeAgentSaveError(new Error('boom'), 'x')).toBe('boom');
    expect(describeAgentSaveError('weird', 'fallback')).toBe('fallback');
    expect(isProfileSaveError(new ApiError('m', 400, 'OTHER'))).toBe(false);
  });
});
