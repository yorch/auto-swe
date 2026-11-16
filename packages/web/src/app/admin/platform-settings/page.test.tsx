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
    update: vi.fn(),
  },
}));

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('@/hooks/useUrlFilters', () => ({
  useUrlFilters: () => ({ params: state.params, update: state.update }),
}));
vi.mock('@/hooks/useHasRole', () => ({ useHasRole: () => state.admin }));
vi.mock('@/hooks/useTemplates', () => ({
  useWorkflowTemplates: () => ({
    data: [
      { id: 'tpl-1', name: 'Fast path', status: 'ACTIVE', team: { id: 't1', name: 'Payments' } },
      { id: 'tpl-2', name: 'Platform default', status: 'ACTIVE', team: null },
      { id: 'tpl-3', name: 'Drafty', status: 'DRAFT', team: { id: 't1', name: 'Payments' } },
      { id: 'tpl-4', name: 'Retired', status: 'ARCHIVED', team: { id: 't1', name: 'Payments' } },
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
const writeSelections: unknown[] = [];
const clearSelections: unknown[] = [];
const clearKeys: string[] = [];
vi.mock('@/hooks/useConfigSettings', () => ({
  useClearConfigSetting: (selection: unknown) => {
    clearSelections.push(selection);
    return {
      mutateAsync: (key: string) => {
        clearKeys.push(key);
        return Promise.resolve({});
      },
    };
  },
  useConfigSettings: (selection: unknown) => {
    selections.push(selection);
    return {
      data: [{ group: 'workflow', key: 'workflow.x', label: 'X', source: 'GLOBAL' }],
      isError: false,
      isLoading: false,
    };
  },
  useSetConfigSetting: (selection: unknown) => {
    writeSelections.push(selection);
    return {
      mutateAsync: () =>
        new Promise<unknown>((resolve, reject) => {
          state.pending = { reject, resolve };
        }),
    };
  },
}));
vi.mock('@/components/settings/SettingRow', () => ({
  SettingRow: ({
    onSave,
    onClear,
    onDirtyChange,
    setting,
    status,
  }: {
    onSave: (v: unknown) => void;
    onClear?: () => void;
    onDirtyChange?: (key: string, dirty: boolean) => void;
    setting: { key: string };
    status?: { phase: string; warnings?: string[] };
  }) => (
    <div>
      <button onClick={() => onSave(1)} type="button">
        save
      </button>
      <button onClick={() => onClear?.()} type="button">
        clear
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
  state.update = vi.fn();
  clearKeys.length = 0;
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
    expect(callout?.textContent).toMatch(
      /team, channel or workflow template changes only that scope/
    );
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

  it('offers active and draft templates, not archived ones', () => {
    state.params = new URLSearchParams('scope=WORKFLOW_TEMPLATE');
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: /Show options/ }));
    expect(screen.getByRole('option', { name: 'Fast path' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Drafty' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Retired' })).toBeNull();
  });

  it('keeps the archived template chosen in the URL so its override can be cleared', () => {
    state.params = new URLSearchParams('scope=WORKFLOW_TEMPLATE&workflowTemplateId=tpl-4');
    render(<Page />);
    expect(screen.getByTestId('scope-bar').textContent).toMatch(/Retired \(template\)/);
    fireEvent.click(screen.getByRole('button', { name: /Show options/ }));
    expect(screen.getByRole('option', { name: 'Retired' })).toBeTruthy();
  });

  it('hands the template selection to the write and clear hooks', async () => {
    state.params = new URLSearchParams('scope=WORKFLOW_TEMPLATE&workflowTemplateId=tpl-1');
    render(<Page />);
    const expected = { scope: 'WORKFLOW_TEMPLATE', workflowTemplateId: 'tpl-1' };
    expect(writeSelections.at(-1)).toEqual(expected);
    expect(clearSelections.at(-1)).toEqual(expected);
    fireEvent.click(screen.getByText('clear'));
    expect(clearKeys).toEqual(['workflow.x']);
    await act(async () => {});
  });

  it.each([
    ['TEAM', 'A team'],
    ['GLOBAL', 'Platform-wide'],
  ])(
    'drops workflowTemplateId from the URL when switching from a template to %s',
    (target, label) => {
      state.params = new URLSearchParams('scope=WORKFLOW_TEMPLATE&workflowTemplateId=tpl-1');
      render(<Page />);
      fireEvent.click(screen.getByRole('button', { name: /View settings for/ }));
      fireEvent.click(screen.getByRole('option', { name: label }));
      expect(state.update).toHaveBeenCalledTimes(1);
      const patch = state.update.mock.calls[0]?.[0];
      expect(patch).toMatchObject({ scope: target === 'GLOBAL' ? null : target });
      expect(patch.workflowTemplateId).toBeNull();
    }
  );

  it('does not offer a platform-wide template to a non-admin even when the URL selects it', () => {
    state.params = new URLSearchParams('scope=WORKFLOW_TEMPLATE&workflowTemplateId=tpl-2');
    state.admin = false;
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: /Show options/ }));
    expect(screen.getByRole('option', { name: 'Fast path' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Platform default' })).toBeNull();
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
