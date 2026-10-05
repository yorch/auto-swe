// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { FigmaTab } from './FigmaTab';
import { IssueTrackerTab } from './IssueTrackerTab';
import { KnowledgeBaseTab } from './KnowledgeBaseTab';

afterEach(() => vi.unstubAllGlobals());

const masked = { lastFour: 'abcd' };

describe('IssueTrackerTab connection test', () => {
  const tracker = {
    data: {
      allowPrivateNetwork: false,
      apiToken: masked,
      baseUrl: 'https://acme.atlassian.net',
      email: 'a@acme.test',
      provider: 'jira',
    },
    sources: {},
  };

  it('sends the typed token and base URL and labels the result as unsaved', async () => {
    const spy = setupFetchMock({
      '/api/v1/platform/config/issue-tracker': () => tracker,
      'POST /api/v1/platform/config/issue-tracker/test': () => ({ detail: 'Fetched it', ok: true }),
    });
    render(withQuery(<IssueTrackerTab />));
    const token = await screen.findByLabelText(/api token/i, { selector: 'input' });
    fireEvent.change(token, { target: { value: 'typed' } });
    fireEvent.change(screen.getByLabelText('Ticket ID'), { target: { value: 'PROJ-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByText('Tested with unsaved values.')).toBeTruthy());
    expect(bodyOf(spy, '/config/issue-tracker/test')).toEqual({
      apiToken: 'typed',
      ticketId: 'PROJ-1',
    });
  });
});

describe('KnowledgeBaseTab connection test', () => {
  it('tests the stored config when nothing was typed', async () => {
    const spy = setupFetchMock({
      '/api/v1/platform/config/knowledge-base': () => ({
        data: {
          allowPrivateNetwork: false,
          apiToken: masked,
          baseUrl: 'https://kb.example.com',
          email: null,
          enabled: true,
          maxPages: null,
          provider: 'confluence',
          spaces: [],
        },
        sources: {},
      }),
      'POST /api/v1/platform/config/knowledge-base/test': () => ({ detail: 'ok', ok: true }),
    });
    render(withQuery(<KnowledgeBaseTab />));
    const button = await screen.findByRole('button', { name: 'Test connection' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText('ok')).toBeTruthy());
    expect(bodyOf(spy, '/config/knowledge-base/test')).toEqual({});
    expect(screen.queryByText('Tested with unsaved values.')).toBeNull();
  });
});

describe('FigmaTab connection test', () => {
  it('sends the typed token and labels the result as unsaved', async () => {
    const spy = setupFetchMock({
      '/api/v1/platform/config/figma': () => ({
        data: { apiToken: null, enabled: true, maxNodes: null },
        sources: {},
      }),
      'POST /api/v1/platform/config/figma/test': () => ({ detail: 'Figma ok', ok: true }),
    });
    render(withQuery(<FigmaTab />));
    const token = await screen.findByLabelText(/api token|personal access token/i, {
      selector: 'input',
    });
    fireEvent.change(token, { target: { value: 'figd_typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByText('Tested with unsaved values.')).toBeTruthy());
    expect(bodyOf(spy, '/config/figma/test')).toEqual({ apiToken: 'figd_typed' });
  });
});
