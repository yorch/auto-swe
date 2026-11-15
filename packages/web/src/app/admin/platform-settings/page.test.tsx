// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';

const { state } = vi.hoisted(() => ({
  state: {
    admin: true,
    params: new URLSearchParams(),
    pending: null as { reject: (e: Error) => void; resolve: (value?: unknown) => void } | null,
    teamsError: false,
  },
}));

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('@/hooks/useUrlFilters', () => ({
  useUrlFilters: () => ({ params: state.params, update: vi.fn() }),
}));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => state.admin }));
vi.mock('@/hooks/useTemplates', () => ({
  useWorkflowTemplates: () => ({
    data: [
      { id: 'tpl-1', name: 'Fast path', team: { id: 't1', name: 'Payments' } },
      { id: 'tpl-2', name: 'Platform default', team: null },
    ],
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock('@/hooks/useTeams', () => ({
  useTeams: () => ({ data: [], isError: state.teamsError, refetch: vi.fn() }),
}));
vi.mock('@/hooks/useSlackChannels', () => ({ useSlackChannels: () => ({ data: [] }) }));
vi.mock('@/hooks/useAdmin', () => ({ useOrganizationDirectory: () => ({ data: [] }) }));
const selections: unknown[] = [];
vi.mock('@/hooks/useConfigSettings', () => ({
  useClearConfigSetting: () => ({ mutateAsync: vi.fn() }),
  useConfigSettings: (selection: unknown) => {
    selections.push(selection);
    return {
      data: [{ group: 'workflow', key: 'workflow.x', label: 'X', source: 'GLOBAL' }],
      isError: false,
      isLoading: false,
    };
  },
  useSetConfigSetting: () => ({
    mutateAsync: () =>
      new Promise<unknown>((resolve, reject) => {
        state.pending = { reject, resolve };
      }),
  }),
}));
vi.mock('@/components/settings/SettingRow', () => ({
  SettingRow: ({
    onSave,
    onDirtyChange,
    setting,
    status,
  }: {
    onSave: (v: unknown) => void;
    onDirtyChange?: (key: string, dirty: boolean) => void;
    setting: { key: string };
    status?: { phase: string; warnings?: string[] };
  }) => (
    <div>
      <button onClick={() => onSave(1)} type="button">
        save
      </button>
      <button onClick={() => onDirtyChange?.(setting.key, true)} type="button">
        edit
      </button>
      <span>status:{status?.phase ?? 'none'}</span>
      {status?.warnings?.map((warning) => (
        <span key={warning}>{warning}</span>
      ))}
    </div>
  ),
}));

const { default: Page } = await import('./page');

beforeEach(() => {
  stubDialogPrototype();
  state.params = new URLSearchParams();
  state.pending = null;
  state.admin = true;
  state.teamsError = false;
});

describe('platform settings page', () => {
  it('explains how settings resolve and links to the doc', () => {
    render(<Page />);
    expect(screen.getByText('How settings resolve')).toBeTruthy();
    expect(screen.getByText(/about 30 seconds/)).toBeTruthy();
    expect(screen.getByText(/does not reach runs already in flight/)).toBeTruthy();
    // The explainer lives in the Help panel, not in a disclosure on the page.
    expect(screen.getByText('How settings resolve').closest('details')).toBeNull();
    expect(
      screen.getAllByRole('link', { name: /About the settings cascade/ })[0]?.getAttribute('href')
    ).toBe('/docs/configuration#2-resolution-order');
  });

  it('warns that a platform-wide save reaches every scope without an override', () => {
    render(<Page />);
    const heading = screen.getByText('Platform-wide saves reach every scope below');
    const callout = heading.closest('[role="note"]');
    expect(callout).not.toBeNull();
    expect(heading.closest('[role="status"], [role="alert"]')).toBeNull();
    expect(callout?.textContent).toMatch(/live value for every team, channel and template/);
    expect(callout?.textContent).toMatch(/team or channel changes only that scope/);
    expect(callout?.textContent).toMatch(
      /organization reaches every team in it that has no override/
    );
    expect(screen.getByRole('link', { name: /Who may change these/ }).getAttribute('href')).toBe(
      '/docs/configuration#3-who-may-change-what'
    );
  });

  it('records a save that settles in the view it started in', async () => {
    render(<Page />);
    fireEvent.click(screen.getByText('save'));
    expect(screen.getByText('status:saving')).toBeTruthy();
    await act(async () => state.pending?.resolve());
    expect(screen.getByText('status:saved')).toBeTruthy();
  });
  it('passes successful-save warnings to the setting row', async () => {
    render(<Page />);
    fireEvent.click(screen.getByText('save'));
    await act(async () => state.pending?.resolve({ warnings: ['No egress proxy'] }));
    expect(screen.getByText('status:saved')).toBeTruthy();
    expect(screen.getByText('No egress proxy')).toBeTruthy();
  });

  it('ignores a save that settles after the scope changed', async () => {
    const { rerender } = render(<Page />);
    fireEvent.click(screen.getByText('save'));
    state.params = new URLSearchParams('scope=TEAM&teamId=t1');
    rerender(<Page />);
    await act(async () => state.pending?.reject(new Error('late failure')));
    expect(screen.queryByText('status:error')).toBeNull();
    expect(screen.queryByText(/late failure/)).toBeNull();
  });

  it('names the scope being edited and counts unsaved changes in a bar that stays in view', () => {
    render(<Page />);
    const bar = screen.getByTestId('scope-bar');
    expect(bar.textContent).toMatch(/Editing:\s*Platform-wide/);
    expect(bar.textContent).toMatch(/saves reach every team/);
    expect(bar.textContent).toMatch(/No unsaved changes/);
    expect(bar.className).toContain('sticky');
    fireEvent.click(screen.getByText('edit'));
    expect(screen.getByTestId('scope-bar').textContent).toMatch(/1 unsaved change\b/);
  });

  it('offers a workflow template scope and sends its id with the selection', () => {
    state.params = new URLSearchParams('scope=WORKFLOW_TEMPLATE&workflowTemplateId=tpl-1');
    render(<Page />);
    expect(selections.at(-1)).toEqual({ scope: 'WORKFLOW_TEMPLATE', workflowTemplateId: 'tpl-1' });
    expect(screen.getByTestId('scope-bar').textContent).toMatch(/Fast path \(template\)/);
    expect(screen.getByRole('button', { name: /Workflow template/ })).toBeTruthy();
  });

  it('offers a platform-wide template only to an admin', () => {
    state.params = new URLSearchParams('scope=WORKFLOW_TEMPLATE');
    state.admin = false;
    const lead = render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: /Show options/ }));
    expect(screen.getByRole('option', { name: 'Fast path' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Platform default' })).toBeNull();
    lead.unmount();
    state.admin = true;
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: /Show options/ }));
    expect(screen.getByRole('option', { name: 'Platform default' })).toBeTruthy();
  });

  it("does not blame the viewed scope's list for another list's failure", () => {
    state.params = new URLSearchParams('scope=WORKFLOW_TEMPLATE');
    state.teamsError = true;
    render(<Page />);
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });

  it('asks before the view changes while a row holds an unsaved draft', () => {
    render(<Page />);
    fireEvent.click(screen.getByText('edit'));
    // The scope picker is a React Aria select: open it and pick another scope.
    fireEvent.click(screen.getByRole('button', { name: /View settings for/ }));
    fireEvent.click(screen.getByRole('option', { name: 'A team' }));
    expect(screen.getByText('Discard unsaved changes?')).toBeTruthy();
  });
});
