import { describe, expect, it } from 'vitest';
import { matchRepoDependency, type RepoDependencyCandidate } from './repoDependencyMatch.js';

const sdk: RepoDependencyCandidate = {
  id: 'repo-sdk',
  organizationName: 'acme',
  packageNames: ['@acme/payments-sdk'],
  repoName: 'payments-api',
};

const shared: RepoDependencyCandidate = {
  id: 'repo-shared',
  organizationName: 'acme',
  packageNames: [],
  repoName: 'shared',
};

const otherOrgShared: RepoDependencyCandidate = {
  id: 'repo-other-shared',
  organizationName: 'other-org',
  packageNames: [],
  repoName: 'shared',
};

const candidates = [sdk, shared];

describe('matchRepoDependency', () => {
  it('returns null for an empty or whitespace-only string', () => {
    expect(matchRepoDependency('', candidates)).toBeNull();
    expect(matchRepoDependency('   ', candidates)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(matchRepoDependency('totally-unrelated-package', candidates)).toBeNull();
  });

  // Tier 1: exact packageNames entry.
  it('matches an exact packageNames entry, case-insensitively', () => {
    expect(matchRepoDependency('@acme/payments-sdk', candidates)).toBe('repo-sdk');
    expect(matchRepoDependency('@ACME/Payments-SDK', candidates)).toBe('repo-sdk');
  });

  it('prefers a packageNames match over an org/repo shape match', () => {
    // "acme/shared" would org/repo-match `shared`, but a packageNames hit on
    // `sdk` (if it declared this exact string) should win. Model this by
    // having packageNames overlap what would otherwise resolve elsewhere.
    const withOverlap: RepoDependencyCandidate = {
      id: 'repo-decoy',
      organizationName: 'acme',
      packageNames: ['acme/shared'],
      repoName: 'decoy',
    };
    expect(matchRepoDependency('acme/shared', [withOverlap, shared])).toBe('repo-decoy');
  });

  // Tier 2: org/repo shape, in every spelling.
  it('matches a bare org/repo string', () => {
    expect(matchRepoDependency('acme/shared', candidates)).toBe('repo-shared');
  });

  it('matches a github.com/org/repo string', () => {
    expect(matchRepoDependency('github.com/acme/shared', candidates)).toBe('repo-shared');
  });

  it('matches an https:// URL, with or without a .git suffix', () => {
    expect(matchRepoDependency('https://github.com/acme/shared', candidates)).toBe('repo-shared');
    expect(matchRepoDependency('https://github.com/acme/shared.git', candidates)).toBe(
      'repo-shared'
    );
  });

  it('matches an scp-style git@ URL', () => {
    expect(matchRepoDependency('git@github.com:acme/shared.git', candidates)).toBe('repo-shared');
  });

  it('matches an npm scoped package as an org/repo shape when no packageNames hit', () => {
    expect(matchRepoDependency('@acme/shared', candidates)).toBe('repo-shared');
  });

  it('is case-insensitive on org and repo', () => {
    expect(matchRepoDependency('ACME/SHARED', candidates)).toBe('repo-shared');
  });

  // Tier 3: bare repo-name equality, weakest tier.
  it('falls back to bare repo-name equality when unambiguous', () => {
    expect(matchRepoDependency('shared', candidates)).toBe('repo-shared');
  });

  it('refuses to guess when a bare name is ambiguous across orgs', () => {
    expect(matchRepoDependency('shared', [shared, otherOrgShared])).toBeNull();
  });

  it('does not resolve an org/repo shape whose org does not match any candidate', () => {
    // Falls through to bare-name tier since "shared" itself is unambiguous.
    expect(matchRepoDependency('someone-else/shared', candidates)).toBe('repo-shared');
  });

  it('returns null when the org/repo org matches but no candidate repoName does', () => {
    expect(matchRepoDependency('acme/nonexistent', candidates)).toBeNull();
  });
});
