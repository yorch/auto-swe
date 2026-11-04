// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { RoleSelectCell } from './RoleSelectCell';

const OPTIONS = [
  { label: 'Engineer', value: 'ENGINEER' },
  { label: 'Lead', value: 'LEAD' },
  { label: 'Admin', value: 'ADMIN' },
];

beforeEach(stubDialogPrototype);
afterEach(cleanup);

function pick(name: string) {
  fireEvent.click(screen.getByRole('button', { name: /Role for a@x.com/ }));
  fireEvent.click(screen.getByRole('option', { name }));
}

describe('RoleSelectCell', () => {
  it('disables the select while saving, then says Saved', async () => {
    let finish: () => void = () => undefined;
    const apply = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(
      <RoleSelectCell
        apply={apply}
        ariaLabel="Role for a@x.com"
        options={OPTIONS}
        value="ENGINEER"
      />
    );
    pick('Lead');
    expect(apply).toHaveBeenCalledWith('LEAD');
    expect(await screen.findByText('Saving…')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Role for a@x.com/ }) as HTMLButtonElement).disabled
    ).toBe(true);
    finish();
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('shows a failure under the control, not in a page-level alert', async () => {
    const apply = vi.fn(() => Promise.reject(new Error('nope')));
    render(
      <RoleSelectCell
        apply={apply}
        ariaLabel="Role for a@x.com"
        options={OPTIONS}
        value="ENGINEER"
      />
    );
    pick('Lead');
    expect((await screen.findByRole('alert')).textContent).toContain('nope');
  });

  it('asks first when confirm flags the change, and applies only on confirmation', async () => {
    const apply = vi.fn(() => Promise.resolve());
    render(
      <RoleSelectCell
        apply={apply}
        ariaLabel="Role for a@x.com"
        confirm={(_from, to) =>
          to === 'ADMIN'
            ? { confirmLabel: 'Make admin', message: 'Full access.', title: 'Make admin?' }
            : null
        }
        options={OPTIONS}
        value="ENGINEER"
      />
    );
    pick('Admin');
    expect(apply).not.toHaveBeenCalled();
    expect(screen.getByText('Full access.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make admin' }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith('ADMIN'));
  });

  it('shows a failed confirmed change once, inside the dialog', async () => {
    const apply = vi.fn(() => Promise.reject(new Error('server said no')));
    render(
      <RoleSelectCell
        apply={apply}
        ariaLabel="Role for a@x.com"
        confirm={() => ({
          confirmLabel: 'Make admin',
          message: 'Full access.',
          title: 'Make admin?',
        })}
        options={OPTIONS}
        value="ENGINEER"
      />
    );
    pick('Admin');
    fireEvent.click(screen.getByRole('button', { name: 'Make admin' }));
    await waitFor(() => expect(screen.getAllByText('server said no')).toHaveLength(1));
  });

  it('explains in visible text why it is disabled', () => {
    render(
      <RoleSelectCell
        apply={vi.fn()}
        ariaLabel="Role for a@x.com"
        disabled
        disabledReason="The only organization admin"
        options={OPTIONS}
        value="ADMIN"
      />
    );
    expect(screen.getByText('The only organization admin')).toBeTruthy();
  });
});
