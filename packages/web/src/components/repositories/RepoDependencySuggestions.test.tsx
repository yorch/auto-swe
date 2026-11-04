// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  parseRepoRef,
  RepoDependencySuggestions,
  type UnresolvedDependencySuggestion,
} from './RepoDependencySuggestions';

const repoA = { id: 'r-a', name: null, organizationName: 'acme', repoName: 'payments-api' };
const repoB = { id: 'r-b', name: null, organizationName: 'acme', repoName: 'billing-svc' };

const suggestions: UnresolvedDependencySuggestion[] = [
  {
    confidence: 1,
    fromRepo: repoA,
    id: 'e1',
    kind: 'code',
    source: 'manifest',
    toRef: '@acme/shared-lib',
  },
  {
    confidence: 1,
    fromRepo: repoB,
    id: 'e2',
    kind: 'code',
    source: 'manifest',
    toRef: '@acme/shared-lib',
  },
  {
    confidence: 1,
    fromRepo: repoA,
    id: 'e3',
    kind: 'code',
    source: 'git_signal',
    toRef: 'github.com/acme/legacy-tool',
  },
];

describe('RepoDependencySuggestions', () => {
  it('shows loading state', () => {
    render(<RepoDependencySuggestions isLoading suggestions={undefined} />);
    expect(screen.getByText(/loading onboarding suggestions/i)).toBeTruthy();
  });

  it('shows an error message', () => {
    render(<RepoDependencySuggestions error={new Error('boom')} isError suggestions={undefined} />);
    expect(screen.getByRole('alert').textContent).toContain('boom');
  });

  it('shows the empty state when there are no suggestions', () => {
    render(<RepoDependencySuggestions suggestions={[]} />);
    expect(screen.getByText(/no suggestions yet/i)).toBeTruthy();
  });

  it('groups suggestions by toRef and counts distinct referencing repos', () => {
    render(<RepoDependencySuggestions suggestions={suggestions} />);

    expect(screen.getByText('@acme/shared-lib')).toBeTruthy();
    expect(screen.getByText('2 repos')).toBeTruthy();
    expect(screen.getByText('acme/payments-api, acme/billing-svc')).toBeTruthy();

    expect(screen.getByText('github.com/acme/legacy-tool')).toBeTruthy();
    expect(screen.getByText('1 repo')).toBeTruthy();
  });

  it('ranks the most-referenced toRef first', () => {
    render(<RepoDependencySuggestions suggestions={suggestions} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toContain('@acme/shared-lib');
    expect(items[1].textContent).toContain('github.com/acme/legacy-tool');
  });

  it('offers Onboard only for a reference that names an organization and repository', () => {
    const onOnboard = vi.fn();
    render(<RepoDependencySuggestions onOnboard={onOnboard} suggestions={suggestions} />);
    expect(screen.queryByRole('button', { name: 'Onboard @acme/shared-lib' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Onboard github.com/acme/legacy-tool' }));
    expect(onOnboard).toHaveBeenCalledWith({ organizationName: 'acme', repoName: 'legacy-tool' });
  });

  it('shows no Onboard button when the viewer cannot add connections', () => {
    render(<RepoDependencySuggestions suggestions={suggestions} />);
    expect(screen.queryByRole('button', { name: /^Onboard/ })).toBeNull();
  });
});

describe('parseRepoRef', () => {
  it('reads org/repo, host-prefixed and URL forms, and rejects package names', () => {
    expect(parseRepoRef('acme/api')).toEqual({ organizationName: 'acme', repoName: 'api' });
    expect(parseRepoRef('https://github.com/acme/api.git')).toEqual({
      organizationName: 'acme',
      repoName: 'api',
    });
    expect(parseRepoRef('@acme/shared-lib')).toBeNull();
    expect(parseRepoRef('lodash')).toBeNull();
  });
});
