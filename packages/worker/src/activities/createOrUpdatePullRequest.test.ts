import type { CodeResult, RepoWorkRequest } from '@auto-swe/shared/types/workflow';
import { describe, expect, it, vi } from 'vitest';

// The activity module pulls in the DB client, integrations and Slack at import
// time; none of that is exercised by the pure template helpers under test.
vi.mock('@auto-swe/shared/db', () => ({ prisma: {} }));
vi.mock('@auto-swe/shared/lib/integrations/registry', () => ({
  createKnowledgeBaseProvider: vi.fn(),
}));
vi.mock('@auto-swe/shared/lib/systemConfig', () => ({
  resolveIssueTrackerConfig: vi.fn(),
  resolveKnowledgeBaseConfig: vi.fn(),
  resolveWorkflowDefaults: vi.fn(),
}));
vi.mock('@auto-swe/shared/lib/trackerSync', () => ({ syncTrackerOnEvent: vi.fn() }));
vi.mock('../lib/scm/index.js', () => ({ getScmProvider: vi.fn(), toRepoRef: vi.fn() }));
vi.mock('../lib/slackNotify.js', () => ({ notifySlackPrReady: vi.fn() }));

import { formatPRBody, formatPRTitle, renderTemplate } from './createOrUpdatePullRequest.js';

const request = {
  description: 'Add {{notes}} to the README and mention $1 and $&',
  externalTicketId: 'JIRA-7',
} as RepoWorkRequest;

const codeResult: CodeResult = {
  branch: 'auto/JIRA-7',
  diff: '',
  filesChanged: [
    {
      language: 'typescript',
      linesAdded: 3,
      linesRemoved: 1,
      operation: 'MODIFY',
      path: 'src/{{ticketId}}.ts',
    },
  ],
  headSha: 'abc',
  implementationNotes: 'Done. Left {{fileList}} and {{description}} alone.',
  testResults: { duration_ms: 1, failing: 0, passed: true, passing: 2, stdout: '', total: 2 },
} as CodeResult;

describe('renderTemplate', () => {
  it('expands each placeholder once and inserts values verbatim', () => {
    expect(renderTemplate('{{a}}-{{b}}-{{a}}', { a: 'x', b: '{{a}}' })).toBe('x-{{a}}-x');
  });

  it('keeps `$` sequences and unknown placeholders literal', () => {
    expect(renderTemplate('[{{a}}] {{missing}}', { a: '$1 $& $$' })).toBe('[$1 $& $$] {{missing}}');
  });
});

describe('formatPRTitle / formatPRBody', () => {
  it('does not expand placeholders smuggled inside the description', () => {
    expect(formatPRTitle(request, '{{ticketId}}: {{description}}')).toBe(
      'JIRA-7: Add {{notes}} to the README and mention $1 and $&'
    );
  });

  it('renders the body in a single pass so values cannot expand each other', () => {
    const body = formatPRBody(request, codeResult);
    // Each value appears exactly as authored, including its own `{{…}}` tokens.
    expect(body).toContain('Add {{notes}} to the README and mention $1 and $&');
    expect(body).toContain('Done. Left {{fileList}} and {{description}} alone.');
    expect(body).toContain('- `src/{{ticketId}}.ts` (MODIFY, +3/-1)');
    // Nothing expanded the smuggled tokens into real values.
    expect(body).not.toContain('src/JIRA-7.ts');
    expect(body.match(/All tests passing/g)).toHaveLength(1);
  });

  it('honours a custom body template', () => {
    expect(
      formatPRBody(request, codeResult, '{{branch}} ({{filesChanged}} files) {{testStatus}}')
    ).toBe('auto/JIRA-7 (1 files) All tests passing (2/2)');
  });
});
