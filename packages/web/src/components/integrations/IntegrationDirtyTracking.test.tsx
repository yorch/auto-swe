// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { FigmaTab } from './FigmaTab';
import { GitHubTab } from './GitHubTab';
import { IssueTrackerTab } from './IssueTrackerTab';
import { KnowledgeBaseTab } from './KnowledgeBaseTab';
import { SlackTab } from './SlackTab';

vi.mock('./GitHubHostCredentialsCard', () => ({ GitHubHostCredentialsCard: () => null }));
vi.mock('./GitHubHostSecretsCard', () => ({ GitHubHostSecretsCard: () => null }));
vi.mock('@/hooks/useSlackChannels', () => ({
  useSlackWorkspaces: () => ({ data: [], isLoading: false }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const masked = { lastFour: 'abcd' };

const configs = {
  figma: {
    data: { apiToken: masked, enabled: true, maxNodes: 12 },
    path: '/api/v1/platform/config/figma',
    tab: <FigmaTab />,
  },
  github: {
    data: {
      apiUrl: null,
      appClientId: null,
      appClientSecret: null,
      appId: null,
      appInstallationId: null,
      appPrivateKey: null,
      authMode: 'auto',
      baseUrl: 'https://ghe.example.com',
      token: masked,
      webhookSecret: null,
    },
    path: '/api/v1/platform/config/github',
    tab: <GitHubTab />,
  },
  kb: {
    data: {
      allowPrivateNetwork: false,
      apiToken: masked,
      baseUrl: 'https://kb.example.com',
      email: null,
      enabled: true,
      maxPages: 20,
      provider: 'confluence',
      spaces: [],
    },
    path: '/api/v1/platform/config/knowledge-base',
    tab: <KnowledgeBaseTab />,
  },
  slack: {
    data: { botToken: masked, clientId: '123.456', clientSecret: null, signingSecret: null },
    path: '/api/v1/platform/config/slack',
    tab: <SlackTab installedTeamId={null} />,
  },
  tracker: {
    data: {
      allowPrivateNetwork: false,
      apiToken: masked,
      baseUrl: 'https://acme.atlassian.net',
      defaultProjectKey: null,
      email: 'a@acme.test',
      epicIssueType: null,
      instanceType: null,
      provider: 'jira',
      storyIssueType: null,
      storyPointsFieldId: null,
      webhookSecret: null,
      webhookTriggerStatus: null,
    },
    path: '/api/v1/platform/config/issue-tracker',
    tab: <IssueTrackerTab />,
  },
} satisfies Record<string, { data: object; path: string; tab: ReactElement }>;

/** A GET that reflects the last PUT, as the real endpoint does once the query refetches. */
function mockConfig(key: keyof typeof configs) {
  const { data, path } = configs[key];
  let current: Record<string, unknown> = { ...data };
  const spy = setupFetchMock({
    [path]: () => ({ data: current, sources: {} }),
    [`PUT ${path}`]: (body) => {
      current = { ...current, ...(body as object) };
      return { data: current };
    },
  });
  return spy;
}

/** Labels carry a source badge and a `current:` echo, so match on the leading text. */
const labelled = (text: string) =>
  screen.findByLabelText(new RegExp(`^${text}`), { selector: 'input' });

const saveButton = () => screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement;

describe.each([
  { field: 'Client ID', key: 'slack' as const, secret: 'Signing secret', typed: '999.000' },
  { field: 'Max nodes', key: 'figma' as const, secret: 'API token', typed: '30' },
  {
    field: 'Base URL',
    key: 'kb' as const,
    secret: 'API token',
    typed: 'https://other.example.com',
  },
  {
    field: 'Base URL',
    key: 'tracker' as const,
    secret: 'API token',
    typed: 'https://other.atlassian.net',
  },
  {
    field: 'Base URL',
    key: 'github' as const,
    secret: 'Webhook secret',
    typed: 'https://ghe2.example.com',
  },
])('$key tab dirty tracking', ({ key, field, secret, typed }) => {
  it('starts clean with Save disabled', async () => {
    mockConfig(key);
    render(withQuery(configs[key].tab));
    await labelled(field);
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/No unsaved changes/)).toBeTruthy();
  });

  it('counts an edit, a typed secret and a cleared field, then reverts when undone', async () => {
    mockConfig(key);
    render(withQuery(configs[key].tab));
    const input = await labelled(field);
    const original = (input as HTMLInputElement).value;

    fireEvent.change(input, { target: { value: typed } });
    expect(saveButton().disabled).toBe(false);
    expect(screen.getByText(/1 unsaved change\./)).toBeTruthy();

    fireEvent.change(await labelled(secret), { target: { value: 'new-secret' } });
    expect(screen.getByText(/2 unsaved changes\./)).toBeTruthy();

    fireEvent.change(await labelled(secret), { target: { value: '' } });
    fireEvent.change(input, { target: { value: original } });
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(input, { target: { value: '' } });
    // Clearing a stored value is a change (it is sent as null).
    expect(saveButton().disabled).toBe(original === '');
  });

  it('saves only what changed and returns to clean afterwards', async () => {
    const spy = mockConfig(key);
    render(withQuery(configs[key].tab));
    const input = await labelled(field);
    fireEvent.change(input, { target: { value: typed } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText('Settings saved.')).toBeTruthy());
    const sent = bodyOf(spy, configs[key].path, 'PUT') as Record<string, unknown>;
    expect(Object.keys(sent)).toHaveLength(1);
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(screen.getByText(/No unsaved changes/)).toBeTruthy();
  });
});

describe('integration unsaved-changes guard', () => {
  it('asks before an in-app link is followed while a tab has edits', async () => {
    mockConfig('slack');
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    render(
      withQuery(
        <>
          <a href="/somewhere-else">Elsewhere</a>
          <SlackTab installedTeamId={null} />
        </>
      )
    );
    const input = await labelled('Client ID');
    fireEvent.click(screen.getByText('Elsewhere'));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '1.2' } });
    fireEvent.click(screen.getByText('Elsewhere'));
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe('knowledge base spaces dirty tracking', () => {
  const withSpaces = (spaces: string[]) => {
    const original = configs.kb.data;
    configs.kb.data = { ...original, spaces };
    return () => {
      configs.kb.data = original;
    };
  };

  it('treats retyping the stored spaces as no change', async () => {
    const restore = withSpaces(['ENG', 'ARCH']);
    try {
      mockConfig('kb');
      render(withQuery(configs.kb.tab));
      const input = await labelled('Spaces');
      fireEvent.change(input, { target: { value: 'ENG,  ARCH' } });
      expect(saveButton().disabled).toBe(true);
      fireEvent.change(input, { target: { value: 'ENG' } });
      expect(saveButton().disabled).toBe(false);
    } finally {
      restore();
    }
  });

  it('ignores a lone comma but clears when the field is emptied outright', async () => {
    const restore = withSpaces(['ENG']);
    try {
      const spy = mockConfig('kb');
      render(withQuery(configs.kb.tab));
      const input = await labelled('Spaces');
      fireEvent.change(input, { target: { value: ',' } });
      expect(saveButton().disabled).toBe(true);
      fireEvent.change(input, { target: { value: '' } });
      expect(saveButton().disabled).toBe(false);
      fireEvent.click(saveButton());
      await waitFor(() => expect(screen.getByText('Settings saved.')).toBeTruthy());
      expect(bodyOf(spy, configs.kb.path, 'PUT')).toEqual({ spaces: [] });
    } finally {
      restore();
    }
  });
});
