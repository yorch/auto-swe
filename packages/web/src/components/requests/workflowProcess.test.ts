import { describe, expect, it } from 'vitest';
import { summarizeWorkflow, workflowGuide } from './workflowProcess';

const summary = { humanSteps: [], outputs: [], phases: [], signals: [] };

describe('workflow process', () => {
  it('extracts human steps, phases and declared outputs from a valid spec', () => {
    const parsed = summarizeWorkflow({
      entry: 'approve',
      name: 'Example',
      nodes: {
        approve: {
          group: 'Review',
          onApprove: 'done',
          onReject: 'done',
          onTimeout: 'done',
          timeout: '1h',
          title: 'Approve the document',
          type: 'humanApproval',
        },
        done: { result: { documentUrl: { literal: 'url' } }, status: 'SUCCESS', type: 'terminate' },
      },
      schemaVersion: 1,
    });
    expect(parsed).toMatchObject({
      humanSteps: ['Approve the document'],
      outputs: ['documentUrl'],
      phases: ['Review'],
    });
  });

  it.each([null, undefined, {}])('handles unavailable or malformed specs', (spec) => {
    expect(summarizeWorkflow(spec)).toBeNull();
    expect(workflowGuide(summarizeWorkflow(spec), null).producesPr).toBe(false);
  });

  it.each([
    { ...summary, outputs: ['prUrl'] },
    { ...summary, outputs: ['pullRequestNumber'] },
    { ...summary, phases: ['Open a pull request'] },
    { ...summary, phases: ['Open PR'] },
  ])('mentions a PR only when declared in outputs or phases', (process) => {
    const guide = workflowGuide(process, 'git_repo');
    expect(guide.producesPr).toBe(true);
    expect(guide.points.join(' ')).toContain('opens a pull request');
  });

  it('uses neutral non-git wording and includes human steps without inventing a PR', () => {
    const guide = workflowGuide(
      { ...summary, humanSteps: ['Approve reply'], outputs: ['ticketUrl'], phases: ['Prepare'] },
      'api_only'
    );
    expect(guide.producesPr).toBe(false);
    expect(guide.points.join(' ')).toContain('record or document');
    expect(guide.points.join(' ')).toContain('Approve reply');
    expect(guide.points.join(' ')).not.toContain('pull request');
  });

  it('makes no delivery promise for an empty git workflow', () => {
    expect(workflowGuide(summary, 'git_repo').producesPr).toBe(false);
    expect(workflowGuide(summary, 'git_repo').points.join(' ')).toContain('declared results');
  });
});
