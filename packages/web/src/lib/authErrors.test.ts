import { describe, expect, it } from 'vitest';
import { describeAuthError } from './authErrors';

describe('describeAuthError', () => {
  it('returns null when there is no error', () => {
    expect(describeAuthError(null)).toBeNull();
    expect(describeAuthError('')).toBeNull();
  });

  it.each([
    ['unable_to_get_user_info', /verified primary email|profile/i],
    ['email_not_found', /verified email/i],
    ['email_not_verified', /verified email/i],
    ['access_denied', /cancel|denied/i],
    ['state_mismatch', /expired|interrupted|start again/i],
    ['state_not_found', /expired|interrupted|start again/i],
    ['invalid_callback_request', /expired|interrupted|start again/i],
    ['invalid_code', /expired|interrupted|start again/i],
    ['no_code', /expired|interrupted|start again/i],
    ['account_already_linked_to_different_user', /already linked/i],
    ['email_does_not_match', /already linked|does not match|different/i],
    ['unable_to_link_account', /link/i],
    ['oauth_provider_not_found', /not available|misconfigured|administrator/i],
    ['no_callback_url', /not available|misconfigured|administrator/i],
  ])('explains %s in plain language', (code, expected) => {
    expect(describeAuthError(code)).toMatch(expected);
  });

  it('never shows the raw machine code for a known error', () => {
    expect(describeAuthError('unable_to_get_user_info')).not.toContain('unable_to_get_user_info');
  });

  it('falls back to a generic message that names an unknown but well-formed code', () => {
    const message = describeAuthError('some_new_error');
    expect(message).toContain('some_new_error');
    expect(message).toMatch(/try again/i);
  });

  it('does not echo a code that is not a plain machine code', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const message = describeAuthError(hostile);
    expect(message).not.toBeNull();
    expect(message).not.toContain('<img');
    expect(message).not.toContain('onerror');
  });

  it('does not echo an oversized code', () => {
    const long = 'a'.repeat(500);
    expect(describeAuthError(long)).not.toContain(long);
  });
});
