// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
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
    expect(screen.getByText('boom')).toBeTruthy();
  });

  it('shows the empty state when there are no suggestions', () => {
    render(<RepoDependencySuggestions suggestions={[]} />);
    expect(screen.getByText(/no onboarding suggestions/i)).toBeTruthy();
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
});
