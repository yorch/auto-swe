import { describe, expect, it } from 'vitest';
import { allowedToolsOfConfig, isQodoConnectionConfig, QODO_READ_TOOLS } from './qodoConnection.js';

/** Every tool the live Qodo catalog marks `access: write` (23). */
const QODO_WRITE_TOOLS = [
  'litegit-approve',
  'litegit-git',
  'litegit-post-comment',
  'litegit-post-inline-comment',
  'litegit-post-inline-comments',
  'litegit-set-labels',
  'litegit-update-description',
  'pr-review-dismiss',
  'pr-review-mark-implemented',
  'review-notes-bind-pr',
  'review-notes-prepare-pr',
  'review-notes-publish-pr',
  'review-notes-publish-track',
  'review-notes-save-pr',
  'review-notes-save-track',
  'review-skills-bulk',
  'review-skills-discover',
  'review-skills-update',
  'rules-bulk',
  'rules-create',
  'rules-set-scope',
  'rules-set-state',
  'rules-update',
];

/** Every tool the live Qodo catalog marks `access: read` (41). */
const EXPECTED_READ_TOOLS = [
  'litegit-blame',
  'litegit-find',
  'litegit-get-commit',
  'litegit-get-issue',
  'litegit-get-pr',
  'litegit-grep',
  'litegit-list-branches',
  'litegit-list-commits',
  'litegit-list-issues',
  'litegit-list-prs',
  'litegit-list-tags',
  'litegit-ls',
  'litegit-read-file',
  'litegit-search-issues',
  'litegit-search-repos',
  'cross-repo-overview',
  'cross-repo-pair',
  'cross-repo-relations',
  'get-pr-review-findings',
  'pull-request-by-file',
  'pull-request-details',
  'pull-request-patch',
  'pull-request-review-history',
  'pull-request-similar',
  'pull-request-similar-suggestions',
  'pull-request-stats',
  'review-notes-find-tracks',
  'review-notes-for-pr',
  'review-notes-get-pr',
  'review-notes-get-track',
  'review-notes-history',
  'review-notes-resolve-repository',
  'review-skills-discovery-status',
  'review-skills-get',
  'review-skills-insights',
  'review-skills-list',
  'review-skills-source-repositories',
  'rules-get',
  'rules-list',
  'rules-metadata',
  'rules-search',
];

describe('QODO_READ_TOOLS', () => {
  it('is exactly the catalog read set', () => {
    expect(EXPECTED_READ_TOOLS).toHaveLength(41);
    expect(QODO_WRITE_TOOLS).toHaveLength(23);
    expect([...QODO_READ_TOOLS].sort()).toEqual([...EXPECTED_READ_TOOLS].sort());
  });

  it('contains no known write tool', () => {
    for (const write of QODO_WRITE_TOOLS) {
      expect(QODO_READ_TOOLS).not.toContain(write);
    }
  });
});

describe('isQodoConnectionConfig', () => {
  it('recognises only the exact marker', () => {
    expect(isQodoConnectionConfig({ integration: 'qodo' })).toBe(true);
    expect(isQodoConnectionConfig({ integration: 'Qodo' })).toBe(false);
    expect(isQodoConnectionConfig({})).toBe(false);
    expect(isQodoConnectionConfig(null)).toBe(false);
    expect(isQodoConnectionConfig('qodo')).toBe(false);
  });
});

describe('allowedToolsOfConfig', () => {
  it('leaves an ordinary connection unrestricted', () => {
    expect(allowedToolsOfConfig({ url: 'https://x' })).toBeUndefined();
    expect(allowedToolsOfConfig(null)).toBeUndefined();
  });

  it('reads a valid list', () => {
    expect(allowedToolsOfConfig({ allowedTools: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(allowedToolsOfConfig({ allowedTools: [] })).toEqual([]);
  });

  it('fails closed on a malformed list, even for an ordinary connection', () => {
    expect(allowedToolsOfConfig({ allowedTools: 'a' })).toEqual([]);
    expect(allowedToolsOfConfig({ allowedTools: ['a', 1] })).toEqual([]);
    expect(allowedToolsOfConfig({ allowedTools: null })).toEqual([]);
    expect(allowedToolsOfConfig({ allowedTools: [''] })).toEqual([]);
    expect(allowedToolsOfConfig({ allowedTools: Array(201).fill('a') })).toEqual([]);
  });

  it('defaults a qodo connection with no list to the read tools', () => {
    expect(allowedToolsOfConfig({ integration: 'qodo' })).toEqual(QODO_READ_TOOLS);
  });

  it('lets an explicit list narrow a qodo connection', () => {
    expect(allowedToolsOfConfig({ allowedTools: ['rules-search'], integration: 'qodo' })).toEqual([
      'rules-search',
    ]);
  });

  it('binds nothing outside the read tools on a qodo connection, whatever the stored list says', () => {
    expect(
      allowedToolsOfConfig({
        allowedTools: ['rules-search', 'litegit-approve', 'rules-update', 'pr-review-dismiss'],
        integration: 'qodo',
      })
    ).toEqual(['rules-search']);
    expect(allowedToolsOfConfig({ allowedTools: QODO_WRITE_TOOLS, integration: 'qodo' })).toEqual(
      []
    );
  });

  it('keeps a corrupt list on a qodo connection empty', () => {
    expect(allowedToolsOfConfig({ allowedTools: 'rules-search', integration: 'qodo' })).toEqual([]);
  });
});
