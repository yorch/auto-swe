import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import { describe, expect, it } from 'vitest';
import { defaultWorkflow, runnableWorkflows, workflowPickerSections } from './workflowPicker';

function template(name: string, overrides: Partial<WorkflowTemplateSummary> = {}) {
  return {
    activeVersion: 1,
    id: name,
    isDefault: false,
    lastRun: null,
    name,
    status: 'ACTIVE',
    team: null,
    ...overrides,
  } as WorkflowTemplateSummary;
}

describe('workflow picker', () => {
  it('limits recent runs to three, newest first, without category duplicates', () => {
    const templates = [
      template('hotfix'),
      ...['docs-refresh', 'dependency-update', 'code-and-ci', 'security-triage'].map(
        (name, index) =>
          template(name, {
            lastRun: { startedAt: `2026-11-0${index + 1}T00:00:00Z` } as NonNullable<
              WorkflowTemplateSummary['lastRun']
            >,
          })
      ),
      template('custom', {
        lastRun: { startedAt: 'invalid' } as NonNullable<WorkflowTemplateSummary['lastRun']>,
      }),
    ];
    const sections = workflowPickerSections(templates);
    expect(sections[0]?.templates.map((item) => item.name)).toEqual([
      'security-triage',
      'code-and-ci',
      'dependency-update',
    ]);
    expect(sections[1]?.templates.map((item) => item.name)).toEqual(['hotfix', 'docs-refresh']);
    expect(sections.flatMap((section) => section.templates)).toHaveLength(templates.length);
  });

  it('uses catalog order, followed by team and other; omits empty sections', () => {
    const sections = workflowPickerSections([
      template('other'),
      template('docs-refresh'),
      template('custom', { team: { id: 't', name: 'Team', slug: 'team' } }),
      template('zendesk-ticket-reply'),
      template('hotfix'),
    ]);
    expect(sections.map((section) => section.id)).toEqual([
      'engineering',
      'support',
      'team',
      'other',
    ]);
    expect(sections[0]?.templates.map((item) => item.name)).toEqual(['hotfix', 'docs-refresh']);
    expect(workflowPickerSections([])).toEqual([]);
  });

  it('filters blocked, inactive, versionless and out-of-scope templates before ranking', () => {
    const templates = [
      template('hotfix'),
      template('review', { kind: 'review' }),
      template('automation', { kind: 'automation' }),
      template('Channel Assistant'),
      template('inactive', { status: 'DRAFT' }),
      template('versionless', { activeVersion: null }),
      template('own', { team: { id: 'own', name: 'Own', slug: 'own' } }),
      template('foreign', { team: { id: 'foreign', name: 'Foreign', slug: 'foreign' } }),
    ];
    expect(runnableWorkflows(templates, 'own').map((item) => item.name)).toEqual(['hotfix', 'own']);
    expect(runnableWorkflows(templates, null).map((item) => item.name)).toEqual([
      'hotfix',
      'own',
      'foreign',
    ]);
  });

  it('prefers the scoped default, falls back to global, and ignores other team defaults', () => {
    const global = template('global', { isDefault: true });
    const own = template('own', {
      isDefault: true,
      team: { id: 'own', name: 'Own', slug: 'own' },
    });
    expect(defaultWorkflow([global, own], 'own')).toBe(own);
    expect(defaultWorkflow([own, global], 'foreign')).toBe(global);
    expect(defaultWorkflow([own, global], null)).toBe(global);
    expect(defaultWorkflow([own], null)).toBeUndefined();
    expect(defaultWorkflow([], 'own')).toBeUndefined();
  });
});
