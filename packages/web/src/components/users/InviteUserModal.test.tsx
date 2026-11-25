// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDialogPrototype } from '@/test/rtl-helpers';
import { InviteUserModal } from './InviteUserModal';

beforeEach(() => stubDialogPrototype());
afterEach(cleanup);

describe('InviteUserModal', () => {
  it('warns what a platform admin can do once that role is chosen, and not for a user', () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <InviteUserModal onClose={vi.fn()} onInvited={vi.fn()} open />
      </QueryClientProvider>
    );
    expect(screen.queryByText(/every capability on every team/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Platform role/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Platform admin' }));
    expect(screen.getByText(/This person will have every capability on every team/)).toBeTruthy();
  });
});
