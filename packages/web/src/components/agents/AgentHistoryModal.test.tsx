// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRow } from '@/hooks/useAgentLibrary';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { AgentHistoryModal } from './AgentHistoryModal';

function version(n: number, over: Record<string, unknown> = {}) {
  return {
    channelId: null,
    createdAt: '2026-01-0' + n + 'T00:00:00Z',
    createdByEmail: 'ada@example.com',
    credentialId: null,
    description: null,
    id: `v${n}`,
    inheritsModelFrom: null,
    isActive: true,
    isBuiltIn: false,
    isVerified: false,
    key: 'reviewer',
    mcpConnectionId: null,
    modelSpec: `anthropic/model-${n}`,
    name: 'Reviewer',
    orgId: null,
    origin: null,
    scope: 'GLOBAL',
    skillRefs: [],
    systemPrompt: `prompt ${n}`,
    teamId: null,
    toolKeys: null,
    version: n,
    workflowTemplateId: null,
    ...over,
  };
}

const AGENT = version(2) as unknown as AgentRow;

beforeEach(() => stubDialogPrototype());
afterEach(() => vi.unstubAllGlobals());

describe('AgentHistoryModal', () => {
  it('lists versions and shows what changed from the previous one', async () => {
    setupFetchMock({
      'GET /api/v1/platform/agent-library/v2/versions': () => ({
        data: [version(2), version(1)],
      }),
    });
    render(withQuery(<AgentHistoryModal agent={AGENT} onClose={vi.fn()} />));
    expect(await screen.findByText('v2')).toBeTruthy();
    expect(screen.getByText('Current')).toBeTruthy();
    expect(screen.getByText('What changed from v1 to v2')).toBeTruthy();
    expect(screen.getByText('anthropic/model-2')).toBeTruthy();
    // Only an older version can be restored.
    expect(screen.queryByRole('button', { name: 'Restore version 2 as a new version' })).toBeNull();
  });

  it('restores an older version as a new one after confirmation', async () => {
    const bodies: unknown[] = [];
    setupFetchMock({
      'GET /api/v1/platform/agent-library/v2/versions': () => ({
        data: [version(2), version(1)],
      }),
      'POST /api/v1/platform/agent-library/v2/restore': (body) => {
        bodies.push(body);
        return { data: version(3) };
      },
    });
    render(withQuery(<AgentHistoryModal agent={AGENT} onClose={vi.fn()} />));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Restore version 1 as a new version' })
    );
    expect(screen.getByText(/saves a new version v3 with the settings of v1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore as new version' }));
    await waitFor(() => expect(bodies).toEqual([{ versionId: 'v1' }]));
    expect(await screen.findByText(/Saved as version 3/)).toBeTruthy();
  });
});
