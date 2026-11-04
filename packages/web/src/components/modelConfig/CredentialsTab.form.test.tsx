// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCredentialRow } from '@/hooks/useModelConfig';
import { setupFetchMock, stubDialogPrototype, withQuery } from '@/test/rtl-helpers';
import { CredentialsTab, needsTypedConfirm } from './CredentialsTab';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const cred = (over: Partial<ProviderCredentialRow>): ProviderCredentialRow =>
  ({
    apiBase: null,
    id: 'c1',
    lastFour: '1234',
    maskedKey: '****1234',
    provider: 'openai',
    scope: 'GLOBAL',
    teamId: null,
    usage: { agents: [], embedding: false, leavesWithoutCredential: [] },
    ...over,
  }) as ProviderCredentialRow;

function gateway(rows: ProviderCredentialRow[]) {
  setupFetchMock({
    'GET /api/v1/platform/credentials': () => ({ data: rows }),
    'GET /api/v1/platform/readiness': () => ({
      data: { items: [], providers: [], ready: true },
    }),
    'GET /api/v1/teams': () => ({ data: [] }),
  });
}

beforeEach(stubDialogPrototype);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('needsTypedConfirm', () => {
  it('asks for typing when the delete removes the last platform credential', () => {
    expect(needsTypedConfirm(cred({}), [cred({})])).toBe(true);
  });

  it('asks for typing when the delete strands an agent', () => {
    const stranding = cred({
      usage: {
        agents: ['reviewer'],
        embedding: false,
        leavesWithoutCredential: [
          {
            detail: 'x',
            orgId: null,
            problem: 'no-credential',
            scope: 'GLOBAL',
            subject: 'reviewer',
            teamId: null,
          },
        ],
      },
    });
    expect(needsTypedConfirm(stranding, [stranding, cred({ id: 'c2' })])).toBe(true);
  });

  it('does not when another platform credential covers the provider', () => {
    expect(needsTypedConfirm(cred({}), [cred({}), cred({ id: 'c2' })])).toBe(false);
  });
});

describe('CredentialsTab: new credential form', () => {
  it('keeps password managers out of the API key field', async () => {
    gateway([]);
    render(withQuery(<CredentialsTab />));
    fireEvent.click(await screen.findByRole('button', { name: 'New credential' }));
    const key = (await screen.findByLabelText(/^API key/)) as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.autocomplete).toBe('new-password');
    expect(key.getAttribute('data-1p-ignore')).not.toBeNull();
    expect((screen.getByLabelText(/API base URL/) as HTMLInputElement).autocomplete).toBe('off');
  });

  it('puts each problem on its field and focuses the first', async () => {
    gateway([]);
    render(withQuery(<CredentialsTab />));
    fireEvent.click(await screen.findByRole('button', { name: 'New credential' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create credential' }));
    expect(await screen.findByText('Enter a provider name.')).toBeTruthy();
    expect(screen.getByText('Enter the API key.')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText(/Provider name/));
  });
});

describe('CredentialsTab: delete', () => {
  it('makes the admin type the provider before deleting the last platform credential', async () => {
    gateway([cred({})]);
    render(withQuery(<CredentialsTab />));
    fireEvent.click(await screen.findByRole('button', { name: /More actions for the openai/ }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const confirm = (await screen.findByRole('button', { name: 'Delete' })) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Type openai to confirm'), {
      target: { value: 'openai' },
    });
    expect(confirm.disabled).toBe(false);
  });
});
