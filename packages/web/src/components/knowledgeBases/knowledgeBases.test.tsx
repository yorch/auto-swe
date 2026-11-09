// @vitest-environment jsdom

import { getStepMetadata } from '@auto-swe/shared/workflow';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import KnowledgeBasesPage from '@/app/knowledge-bases/page';
import { SchemaAwareForm } from '@/components/workflow/inspectorFields';
import {
  type KnowledgeBase,
  type KnowledgeBaseRunOverrides,
  knowledgeBaseOverrideBody,
} from '@/hooks/useKnowledgeBases';
import { useAuthStore } from '@/stores/authStore';
import { bodyOf, setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { KnowledgeBaseLinksSection } from './KnowledgeBaseLinksSection';
import { KnowledgeBasePicker } from './KnowledgeBasePicker';

const base = (over: Partial<KnowledgeBase> = {}): KnowledgeBase => ({
  connection: { team: { id: 'team1', name: 'Platform' }, teamId: 'team1' },
  connectionId: 'repo1',
  defaultRef: null,
  description: 'Operations reference',
  id: 'kb1',
  lastError: null,
  lastIndexedAt: '2026-09-01T00:00:00Z',
  lastIndexedSha: 'abcdef0123456789',
  mountName: 'ops',
  name: 'Ops docs',
  orgId: 'org1',
  path: 'docs',
  shares: [],
  snapshots: [
    {
      bytes: 100,
      chunkCount: 2,
      error: null,
      fileCount: 1,
      flaggedFiles: [{ path: 'docs/unsafe.md', reason: 'injection' }],
      id: 'snapshot1',
      indexedAt: '2026-09-01T00:00:00Z',
      sha: 'abcdef0123456789',
      skippedFiles: [{ path: 'docs/large.md', reason: 'per_file_bytes' }],
      status: 'READY',
    },
  ],
  status: 'OK',
  visibility: 'TEAM',
  ...over,
});
const repo = {
  id: 'repo1',
  isActive: true,
  organizationName: 'acme',
  repoName: 'ops',
  team: { id: 'team1', name: 'Platform' },
  type: 'git_repo',
};
const inherited = {
  knowledgeBaseId: 'kb1',
  mandatory: true,
  mountName: null,
  ref: null,
  source: 'TEAM',
};
function mock(rows = [base()], extra: Record<string, (body?: unknown) => unknown> = {}) {
  let current = rows;
  return setupFetchMock({
    'DELETE /api/v1/knowledge-base-links/link1': () => ({}),
    'DELETE /api/v1/knowledge-bases/kb1': () => {
      current = current.filter((row) => row.id !== 'kb1');
      return {};
    },
    'GET /api/v1/knowledge-base-links': () => ({ data: [] }),
    'GET /api/v1/knowledge-bases': () => ({ data: current }),
    'GET /api/v1/knowledge-bases/kb1': () => ({ data: current[0] }),
    'GET /api/v1/knowledge-bases/new-kb': () => ({
      data: current.find((row) => row.id === 'new-kb'),
    }),
    'GET /api/v1/repositories': () => ({
      data: [repo, { ...repo, id: 'repo2', repoName: 'manual' }],
      meta: { total: 2 },
    }),
    'GET /api/v1/repositories/repo1/knowledge-bases/effective': () => ({
      data: { dropped: [], refusedExclusions: [], selected: [inherited] },
    }),
    'GET /api/v1/repositories/repo1/share-candidates': () => ({
      data: [{ id: 'team2', name: 'Payments' }],
    }),
    // The team list carries the caller's own role in each team (`myRole`); the led-team set is
    // derived from it, so there is no per-team detail request to mock.
    'GET /api/v1/teams': () => ({
      data: [
        { id: 'team1', myRole: 'LEAD', name: 'Platform', orgId: 'org1', orgName: 'Acme' },
        { id: 'team2', myRole: 'ENGINEER', name: 'Payments', orgId: 'org1', orgName: 'Acme' },
      ],
    }),
    'GET /api/v1/teams/team1/knowledge-bases/effective': () => ({
      data: { dropped: [], refusedExclusions: [], selected: [inherited] },
    }),
    'PATCH /api/v1/knowledge-base-links/link1': () => ({ data: {} }),
    'PATCH /api/v1/knowledge-bases/kb1': (body) => {
      current = current.map((row) =>
        row.id === 'kb1' ? { ...row, ...(body as Partial<KnowledgeBase>) } : row
      );
      return { data: current[0] };
    },
    'POST /api/v1/knowledge-base-links': () => ({ data: {} }),
    'POST /api/v1/knowledge-bases': (body) => {
      const row = base({ ...(body as Partial<KnowledgeBase>), id: 'new-kb' });
      current = [...current, row];
      return { data: row };
    },
    'POST /api/v1/knowledge-bases/kb1/reindex': () => ({ data: { triggered: true } }),
    'PUT /api/v1/knowledge-bases/kb1/shares': () => ({ data: {} }),
    ...extra,
  });
}
async function pick(label: string, option: string) {
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(label, 'i') }));
  fireEvent.click(await screen.findByRole('option', { name: option }));
}
function openPicker() {
  const details = screen.getByText('Knowledge bases · optional').closest('details');
  if (!details) {
    throw new Error('missing picker');
  }
  details.open = true;
  fireEvent(details, new Event('toggle'));
}
beforeEach(() => {
  stubDialogPrototype();
  useAuthStore.setState({ isAuthenticated: true, user: { role: 'ADMIN', sub: 'me' } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAuthStore.setState({ isAuthenticated: false, user: null });
});

describe('knowledge base page', () => {
  it('shows owner, visibility, status, indexing and snapshot file reasons', async () => {
    mock([base({ lastError: 'Indexing failed' })]);
    render(withQuery(<KnowledgeBasesPage />));
    expect(await screen.findByText('Ops docs')).toBeTruthy();
    expect(screen.getByText(/Owner team: Platform/)).toBeTruthy();
    expect(screen.getByText('abcdef0')).toBeTruthy();
    expect(screen.getByText('Indexing failed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Details and snapshots' }));
    expect(await screen.findByText('Latest snapshots (up to 10)')).toBeTruthy();
    expect(screen.getByText('docs/unsafe.md')).toBeTruthy();
    expect(screen.getByText(/injection/)).toBeTruthy();
    expect(screen.getByText('docs/large.md')).toBeTruthy();
    expect(screen.getByText(/per file bytes/)).toBeTruthy();
  });
  it('hides management actions from engineers, and from leads of another team', async () => {
    useAuthStore.setState({ user: { role: 'LEAD', sub: 'me' } });
    mock([
      base({
        connection: { team: { id: 'team2', name: 'Payments' }, teamId: 'team2' },
        visibility: 'ORG',
      }),
    ]);
    render(withQuery(<KnowledgeBasesPage />));
    await screen.findByText('Ops docs');
    await screen.findByRole('button', { name: 'Create knowledge base' });
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reindex' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    cleanup();
    useAuthStore.setState({ user: { role: 'ENGINEER', sub: 'me' } });
    render(withQuery(<KnowledgeBasesPage />));
    await screen.findByText('Ops docs');
    expect(screen.queryByRole('button', { name: 'Create knowledge base' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });
  it('creates from an eligible connection and edits fields without changing its connection', async () => {
    const spy = mock();
    render(withQuery(<KnowledgeBasesPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Create knowledge base' }));
    await pick('Repository connection', 'acme/manual · Platform');
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Playbook' } });
    fireEvent.change(screen.getByLabelText(/^Mount name/), { target: { value: 'playbook' } });
    await pick('Visibility', 'Entire organization');
    fireEvent.click(screen.getByRole('button', { name: 'Save knowledge base' }));
    await screen.findByText('Knowledge base saved.');
    expect(bodyOf(spy, '/knowledge-bases', 'POST')).toEqual({
      connectionId: 'repo2',
      defaultRef: null,
      description: '',
      mountName: 'playbook',
      name: 'Playbook',
      path: '',
      status: 'OK',
      visibility: 'ORG',
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[1]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    fireEvent.change(screen.getByLabelText('Default ref'), { target: { value: 'release/v2' } });
    await pick('Status', 'Disabled');
    fireEvent.click(screen.getByRole('button', { name: 'Save knowledge base' }));
    await waitFor(() =>
      expect(bodyOf(spy, '/knowledge-bases/kb1', 'PATCH')).toMatchObject({
        defaultRef: 'release/v2',
        status: 'DISABLED',
      })
    );
    expect(bodyOf(spy, '/knowledge-bases/kb1', 'PATCH')).not.toHaveProperty('connectionId');
  });
  it('manages only same-organization share candidates and requests a reindex', async () => {
    const spy = mock([base({ visibility: 'SHARED' })]);
    render(withQuery(<KnowledgeBasesPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage shares' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Payments' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save shares' }));
    await waitFor(() =>
      expect(bodyOf(spy, '/knowledge-bases/kb1/shares', 'PUT')).toEqual({ teamIds: ['team2'] })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Reindex' }));
    await screen.findByText(/Reindex requested/);
    expect(bodyOf(spy, '/knowledge-bases/kb1/reindex')).toEqual({});
  });
  it('confirms deletion and shows the empty state', async () => {
    const spy = mock();
    render(withQuery(<KnowledgeBasesPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(spy.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete knowledge base' }));
    expect(await screen.findByText('No knowledge bases yet')).toBeTruthy();
  });
  it('handles an empty same-org team directory and keeps failed share writes open', async () => {
    mock([base({ visibility: 'SHARED' })], {
      'GET /api/v1/repositories/repo1/share-candidates': () => ({ data: [] }),
    });
    render(withQuery(<KnowledgeBasesPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage shares' }));
    expect(await screen.findByText('No other active teams in this organization.')).toBeTruthy();
    cleanup();
    mock([base({ visibility: 'SHARED' })], {
      'PUT /api/v1/knowledge-bases/kb1/shares': () => {
        throw new Error('share refused');
      },
    });
    render(withQuery(<KnowledgeBasesPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage shares' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Payments' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save shares' }));
    expect(await screen.findByText('share refused')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('shows an error, not an empty list, and keeps failed edits open', async () => {
    mock([], {
      'GET /api/v1/knowledge-bases': () => {
        throw new Error('catalog unavailable');
      },
    });
    render(withQuery(<KnowledgeBasesPage />));
    expect(await screen.findByText(/Could not load knowledge bases/)).toBeTruthy();
    expect(screen.queryByText('No knowledge bases yet')).toBeNull();
    cleanup();
    mock([base()], {
      'PATCH /api/v1/knowledge-bases/kb1': () => {
        throw new Error('save unavailable');
      },
    });
    render(withQuery(<KnowledgeBasesPage />));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save knowledge base' }));
    expect(await screen.findByText('save unavailable')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('knowledge base links', () => {
  it('creates TEAM defaults with ref, mount name and mandatory, and updates/removes links', async () => {
    const spy = mock([base()], {
      'GET /api/v1/knowledge-base-links': () => ({
        data: [
          {
            exclude: false,
            id: 'link1',
            knowledgeBaseId: 'old',
            mandatory: false,
            mountName: null,
            ref: null,
          },
        ],
      }),
    });
    render(
      withQuery(
        <KnowledgeBaseLinksSection
          canManage
          target={{ scope: 'TEAM', teamId: 'team1' }}
          teamId="team1"
        />
      )
    );
    await pick('Knowledge base to link', 'Ops docs');
    fireEvent.change(screen.getByLabelText('Link ref'), { target: { value: 'release' } });
    fireEvent.change(screen.getByLabelText('Link mount name'), { target: { value: 'manual' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mandatory for team runs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    await waitFor(() =>
      expect(bodyOf(spy, '/knowledge-base-links')).toEqual({
        exclude: false,
        knowledgeBaseId: 'kb1',
        mandatory: true,
        mountName: 'manual',
        ref: 'release',
        scope: 'TEAM',
        teamId: 'team1',
      })
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mandatory old' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save link' }));
    await waitFor(() =>
      expect(bodyOf(spy, '/knowledge-base-links/link1', 'PATCH')).toMatchObject({ mandatory: true })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }));
    await waitFor(() =>
      expect(
        spy.mock.calls.some(
          ([url, init]) =>
            String(url).includes('/knowledge-base-links/link1') && init?.method === 'DELETE'
        )
      ).toBe(true)
    );
  });
  it('shows a REPO effective preview including source and mandatory without granting writes', async () => {
    const spy = mock();
    render(
      withQuery(
        <KnowledgeBaseLinksSection
          canManage={false}
          target={{ repoId: 'repo1', scope: 'REPO' }}
          teamId="team1"
        />
      )
    );
    expect(await screen.findByText(/Ops docs · TEAM · mandatory/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add link' })).toBeNull();
    expect(spy.mock.calls.some(([url]) => String(url).includes('/knowledge-base-links?'))).toBe(
      false
    );
  });
  it('locks mandatory template exclusions, allows optional exclusions and restores inheritance', async () => {
    const spy = mock([base(), base({ id: 'kb2', name: 'Optional docs' })], {
      'GET /api/v1/teams/team1/knowledge-bases/effective': () => ({
        data: {
          dropped: [],
          refusedExclusions: [],
          selected: [inherited, { ...inherited, knowledgeBaseId: 'kb2', mandatory: false }],
        },
      }),
    });
    render(
      withQuery(
        <KnowledgeBaseLinksSection
          canManage
          target={{ scope: 'TEMPLATE', templateId: 'tpl1' }}
          teamId="team1"
        />
      )
    );
    await screen.findByText('Ops docs · TEAM · mandatory — locked');
    const buttons = screen.getAllByRole('button', { name: 'Exclude' });
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(buttons[1]);
    await waitFor(() =>
      expect(bodyOf(spy, '/knowledge-base-links')).toMatchObject({
        exclude: true,
        knowledgeBaseId: 'kb2',
        mandatory: false,
        scope: 'TEMPLATE',
        templateId: 'tpl1',
      })
    );
    cleanup();
    const restore = mock([base()], {
      'GET /api/v1/knowledge-base-links': () => ({
        data: [
          {
            exclude: true,
            id: 'link1',
            knowledgeBaseId: 'kb1',
            mandatory: false,
            mountName: null,
            ref: null,
          },
        ],
      }),
    });
    render(
      withQuery(
        <KnowledgeBaseLinksSection
          canManage
          target={{ scope: 'TEMPLATE', templateId: 'tpl1' }}
          teamId="team1"
        />
      )
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Restore inheritance' }));
    await waitFor(() =>
      expect(
        restore.mock.calls.some(
          ([url, init]) =>
            String(url).includes('/knowledge-base-links/link1') && init?.method === 'DELETE'
        )
      ).toBe(true)
    );
  });
  it('surfaces link-write errors', async () => {
    mock([base()], {
      'POST /api/v1/knowledge-base-links': () => {
        throw new Error('link refused');
      },
    });
    render(
      withQuery(
        <KnowledgeBaseLinksSection
          canManage
          target={{ scope: 'TEAM', teamId: 'team1' }}
          teamId="team1"
        />
      )
    );
    await pick('Knowledge base to link', 'Ops docs');
    fireEvent.click(screen.getByRole('button', { name: 'Add link' }));
    expect(await screen.findByText('link refused')).toBeTruthy();
  });
});

function PickerHarness({
  repoId,
  teamId,
  initial = {},
}: {
  repoId?: string;
  teamId?: string;
  initial?: KnowledgeBaseRunOverrides;
}) {
  const [value, setValue] = useState<KnowledgeBaseRunOverrides>(initial);
  return (
    <>
      <KnowledgeBasePicker onChange={setValue} repoId={repoId} teamId={teamId} value={value} />
      <output data-testid="override">{JSON.stringify(knowledgeBaseOverrideBody(value))}</output>
    </>
  );
}
describe('run knowledge base picker and registry field', () => {
  it('removes stale exclusions when a default becomes mandatory', async () => {
    mock();
    render(withQuery(<PickerHarness initial={{ exclude: ['kb1'] }} repoId="repo1" />));
    openPicker();
    await screen.findByRole('checkbox', { name: /mandatory/ });
    await waitFor(() => expect(screen.getByTestId('override').textContent).toBe('{}'));
  });
  it('loads lazily, locks mandatory defaults, sends id/ref wire overrides and removes additions', async () => {
    const spy = mock([base(), base({ id: 'kb2', name: 'Extra docs' })]);
    render(withQuery(<PickerHarness repoId="repo1" />));
    expect(spy).not.toHaveBeenCalled();
    openPicker();
    const locked = await screen.findByRole('checkbox', { name: /Ops docs · TEAM · mandatory/ });
    expect((locked as HTMLInputElement).disabled).toBe(true);
    expect((locked as HTMLInputElement).checked).toBe(true);
    await pick('Add knowledge base', 'Extra docs');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.change(screen.getByLabelText('Extra docs ref'), { target: { value: 'v2' } });
    expect(JSON.parse(screen.getByTestId('override').textContent ?? '{}')).toEqual({
      knowledgeBases: { add: [{ id: 'kb2', ref: 'v2' }] },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Extra docs addition' }));
    expect(screen.getByTestId('override').textContent).toBe('{}');
  });
  it('uses team previews for repo-less runs and excludes only optional inherited KBs', async () => {
    const spy = mock([base()], {
      'GET /api/v1/teams/team1/knowledge-bases/effective': () => ({
        data: {
          dropped: [],
          refusedExclusions: [],
          selected: [{ ...inherited, mandatory: false }],
        },
      }),
    });
    render(withQuery(<PickerHarness teamId="team1" />));
    openPicker();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Ops docs · TEAM/ }));
    expect(JSON.parse(screen.getByTestId('override').textContent ?? '{}')).toEqual({
      knowledgeBases: { exclude: ['kb1'] },
    });
    expect(
      spy.mock.calls.some(([url]) => String(url).includes('/teams/team1/knowledge-bases/effective'))
    ).toBe(true);
  });
  it('renders an empty inherited set and a retriable preview error without inventing defaults', async () => {
    mock([], {
      'GET /api/v1/teams/team1/knowledge-bases/effective': () => ({
        data: { dropped: [], refusedExclusions: [], selected: [] },
      }),
    });
    render(withQuery(<PickerHarness teamId="team1" />));
    openPicker();
    expect(await screen.findByText('No inherited references')).toBeTruthy();
    cleanup();
    mock([], {
      'GET /api/v1/teams/team1/knowledge-bases/effective': () => {
        throw new Error('preview unavailable');
      },
    });
    render(withQuery(<PickerHarness teamId="team1" />));
    openPicker();
    expect(await screen.findByText(/Could not load inherited knowledge bases/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
  it('renders the registry knowledgeBases boolean with its default and preserves explicit false', () => {
    const fields = getStepMetadata('retrieveKnowledge').configFields ?? [];
    const onChange = vi.fn();
    const { rerender } = render(
      <SchemaAwareForm fields={fields} onChange={onChange} values={{}} />
    );
    const checkbox = screen.getByRole('checkbox', { name: /^Knowledge bases/ }) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith('knowledgeBases', false);
    rerender(
      <SchemaAwareForm fields={fields} onChange={onChange} values={{ knowledgeBases: false }} />
    );
    expect(
      (screen.getByRole('checkbox', { name: /^Knowledge bases/ }) as HTMLInputElement).checked
    ).toBe(false);
  });
});
