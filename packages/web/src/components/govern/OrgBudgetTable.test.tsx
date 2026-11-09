// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OrgBudgetTable, type OrgBudgetTableRow } from './OrgBudgetTable';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/organizations',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

const base: OrgBudgetTableRow = {
  alert: { percent: 40.5, triggered: false },
  budgetAlertThresholdPercent: 80,
  id: 'o1',
  name: 'Acme',
  slug: 'acme',
};

describe('OrgBudgetTable', () => {
  it('shows a dash, not "No cap" or $0.00, for a row whose dollars the caller may not read', () => {
    render(<OrgBudgetTable columns={['name', 'cap', 'spent', 'percentUsed']} rows={[base]} />);
    expect(screen.queryByText('No cap')).toBeNull();
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('40.5%')).toBeTruthy();
  });

  it('still shows No cap and $0.00 where the server sent null', () => {
    render(
      <OrgBudgetTable
        columns={['name', 'cap', 'spent']}
        rows={[{ ...base, currentMonthUsage: null, monthlyBudgetUsdCents: null }]}
      />
    );
    expect(screen.getByText('No cap')).toBeTruthy();
    expect(screen.getByText('$0.00')).toBeTruthy();
  });
});
