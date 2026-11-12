import { describe, expect, it } from 'vitest';
import { humanizeWorkflowKey, workflowFieldLabel } from './workflowLabels';

describe('humanizeWorkflowKey', () => {
  it('uses declared titles first and distinguishes non-git connections from repositories', () => {
    expect(
      workflowFieldLabel('connectionId', { connectionType: 'git_repo', type: 'connection' })
    ).toBe('Repository');
    expect(
      workflowFieldLabel('connectionId', { connectionType: 'zendesk', type: 'connection' })
    ).toBe('Zendesk connection');
    expect(
      workflowFieldLabel('connectionId', {
        connectionType: 'zendesk',
        title: 'Support account',
        type: 'connection',
      })
    ).toBe('Support account');
    expect(workflowFieldLabel('ticketId', { title: {} })).toBe('Ticket ID');
  });
  it.each([
    ['connectionId', 'Repository'],
    ['ticketId', 'Ticket ID'],
    ['githubRunId', 'GitHub run ID'],
    ['pullRequestNumber', 'Pull request number'],
    ['prdContent', 'PRD content'],
    ['prUrl', 'PR URL'],
    ['prNumber', 'PR number'],
    ['APIBaseURL', 'API base URL'],
    ['ciRunId', 'CI run ID'],
    ['draft_pr', 'Draft PR'],
    ['PR_OPENED', 'PR opened'],
    ['code_security.scan', 'Code security scan'],
    ['customValue', 'Custom value'],
    ['constructor', 'Constructor'],
    ['', ''],
  ])('labels %s as %s', (key, expected) => {
    expect(humanizeWorkflowKey(key)).toBe(expected);
  });
});
