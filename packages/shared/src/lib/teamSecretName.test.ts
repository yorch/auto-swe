import { describe, expect, it } from 'vitest';
import { isReservedTeamSecretName, MAX_TEAM_SECRETS, TeamSecretNameSchema } from './repoSetup.js';

describe('TeamSecretNameSchema', () => {
  it.each([
    'NPM_TOKEN',
    'PIP_INDEX_TOKEN',
    'HOMEBREW_TOKEN',
    'PATHS',
    'USERNAME',
    'GITHUB_TOKEN',
    'ASW',
    'PROXY',
  ])('accepts %s', (name) => {
    expect(TeamSecretNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'NODE_OPTIONS',
    'NODE_EXTRA_CA_CERTS',
    'GIT_ASKPASS',
    'GIT_SSH_COMMAND',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'ASW_ANYTHING',
    'CONTAINER_STEP_INPUT',
  ])('rejects the reserved name %s', (name) => {
    expect(TeamSecretNameSchema.safeParse(name).success).toBe(false);
  });

  it('rejects reserved names in any case through the predicate', () => {
    expect(isReservedTeamSecretName('https_proxy')).toBe(true);
    expect(isReservedTeamSecretName('no_proxy')).toBe(true);
    expect(isReservedTeamSecretName('npm_token')).toBe(false);
  });

  it('still applies the repository secret name rules', () => {
    expect(TeamSecretNameSchema.safeParse('lower_case').success).toBe(false);
    expect(TeamSecretNameSchema.safeParse('1BAD').success).toBe(false);
    expect(TeamSecretNameSchema.safeParse('A'.repeat(101)).success).toBe(false);
  });

  it('caps a team at 50 secrets', () => {
    expect(MAX_TEAM_SECRETS).toBe(50);
  });
});
