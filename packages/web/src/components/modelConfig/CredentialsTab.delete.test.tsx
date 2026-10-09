// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProviderCredentialRow } from '@/hooks/useModelConfig';
import { deleteMessage } from './CredentialsTab';

const row = (usage: ProviderCredentialRow['usage']): ProviderCredentialRow =>
  ({
    id: 'c',
    lastFour: '1234',
    provider: 'openrouter',
    scope: 'TEAM',
    usage,
  }) as ProviderCredentialRow;

describe('deleteMessage', () => {
  it('lists what the delete leaves without any credential', () => {
    render(
      deleteMessage(
        row({
          agents: [],
          embedding: false,
          leavesWithoutCredential: [
            {
              detail: 'x',
              orgId: null,
              problem: 'no-credential',
              scope: 'TEAM',
              subject: 'domainLogicReviewer',
              teamId: 't-1',
            },
            {
              detail: 'y',
              orgId: null,
              problem: 'no-credential',
              scope: 'GLOBAL',
              subject: 'embeddings',
              teamId: null,
            },
          ],
        }),
        []
      )
    );
    expect(screen.getByText(/This leaves 2 with no credential/)).toBeTruthy();
    expect(screen.getByText(/\(team override\)/)).toBeTruthy();
    expect(screen.getByText('Semantic memory embeddings')).toBeTruthy();
  });

  it('says nothing about stranding when the delete leaves everything covered', () => {
    render(deleteMessage(row({ agents: [], embedding: false, leavesWithoutCredential: [] }), []));
    expect(screen.queryByText(/with no credential/)).toBeNull();
  });
});
