// @vitest-environment jsdom
import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { WorkflowLaunchForm } from './WorkflowLaunchForm';

const template = {
  activeVersion: 2,
  createdAt: '',
  description: 'Produces a short summary.',
  experimentSplit: null,
  experimentVersion: null,
  id: 'template-1',
  inputSchema: {
    properties: { description: { type: 'string' } },
    required: ['description'],
    type: 'object',
  },
  isDefault: false,
  lastRun: null,
  name: 'Write a summary',
  status: 'ACTIVE',
  team: null,
  updatedAt: '',
  versionCount: 2,
  webhookConfigured: false,
} satisfies WorkflowTemplateSummary;
afterEach(() => vi.unstubAllGlobals());

function gateway() {
  const bodies: unknown[] = [];
  setupFetchMock({
    'GET /api/v1/repositories': () => ({ data: [], meta: { total: 0 } }),
    'GET /api/v1/workflow-templates/template-1': () => ({
      data: {
        ...template,
        activeVersionSpec: {
          spec: {
            entry: 'done',
            name: 'Summary',
            nodes: {
              done: {
                result: { text: { literal: 'summary' } },
                status: 'SUCCESS',
                type: 'terminate',
              },
            },
            schemaVersion: 1,
          },
        },
      },
    }),
    'POST /api/v1/workflow-templates/template-1/runs': (body) => {
      bodies.push(body);
      return { data: { temporalWorkflowId: 'wf-1', workRequestId: 'request-1' } };
    },
  });
  return bodies;
}

describe('workflow launch', () => {
  it('validates inputs, preserves them on Back, and launches once after review', async () => {
    const bodies = gateway();
    const launched = vi.fn();
    render(withQuery(<WorkflowLaunchForm onLaunched={launched} template={template} />));
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    expect(screen.getByText('Name this task before continuing')).toBeTruthy();
    expect(bodies).toEqual([]);
    fireEvent.change(screen.getByLabelText(/Task name/), {
      target: { value: 'Summarize the release' },
    });
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: 'Use the release notes' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    expect(await screen.findByText('Declared outputs')).toBeTruthy();
    expect(bodies).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Back to details' }));
    expect((screen.getByLabelText(/Description/) as HTMLInputElement).value).toBe(
      'Use the release notes'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review workflow' }));
    const button = screen.getByRole('button', { name: 'Launch workflow' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(launched).toHaveBeenCalledWith('request-1'));
    expect(bodies).toEqual([
      { label: 'Summarize the release', payload: { description: 'Use the release notes' } },
    ]);
  });
});
