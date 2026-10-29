// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bodyOf, setupFetchMock, withQuery } from '@/test/rtl-helpers';
import { DeviceScreen } from './DeviceScreen';

const assign = vi.fn();
const SESSION = {
  session: { expiresAt: '2099-01-01T00:00:00.000Z', id: 's1' },
  user: { id: 'u1', isActive: true, role: 'ENGINEER' },
};

function mockGateway(status: 'pending' | 'approved' | 'denied' = 'pending') {
  return setupFetchMock({
    '/api/auth/device': () => ({
      client_id: 'c1',
      resource: 'https://auto.test/api/v1/mcp',
      scope: 'mcp:read mcp:write offline_access',
      status,
    }),
    '/api/auth/get-session': () => SESSION,
    '/api/auth/oauth2/public-client': () => ({ client_name: 'SSH Agent' }),
    'POST /api/auth/device/approve': () => ({ success: true }),
    'POST /api/auth/device/deny': () => ({ success: true }),
  });
}

beforeEach(() => {
  assign.mockReset();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => vi.unstubAllGlobals());

describe('DeviceScreen', () => {
  it('requires sign-in and preserves the device request', async () => {
    const spy = setupFetchMock({ '/api/auth/get-session': () => null });
    render(withQuery(<DeviceScreen search="user_code=ABC-123" />));
    expect((await screen.findByRole('link', { name: 'Sign in' })).getAttribute('href')).toBe(
      '/login?redirect=%2Fdevice%3Fuser_code%3DABC-123'
    );
    expect(spy).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/auth/device'),
      expect.anything()
    );
  });

  it('shows the exact requested access, warning and resource, then approves all scopes', async () => {
    const spy = mockGateway();
    render(withQuery(<DeviceScreen search="user_code=ABC-123" />));
    expect(await screen.findByText('SSH Agent')).toBeTruthy();
    expect(screen.getByText('https://auto.test/api/v1/mcp')).toBeTruthy();
    expect(screen.getByText('mcp:read mcp:write offline_access')).toBeTruthy();
    expect(screen.getByText(/Only approve a code you started yourself/i)).toBeTruthy();
    expect(screen.getByText(/Approval grants all requested scopes/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(bodyOf(spy, '/api/auth/device/approve')).toEqual({ userCode: 'ABC-123' })
    );
    expect(await screen.findByText('Device approved')).toBeTruthy();
  });

  it('supports denial and presents the terminal status', async () => {
    const spy = mockGateway();
    render(withQuery(<DeviceScreen search="user_code=ABC-123" />));
    await screen.findByText('SSH Agent');
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(bodyOf(spy, '/api/auth/device/deny')).toEqual({ userCode: 'ABC-123' })
    );
    expect(await screen.findByText('Device denied')).toBeTruthy();
  });

  it('shows expired and invalid requests without exposing provider text', async () => {
    setupFetchMock({
      '/api/auth/device': () => {
        throw new Error('expired');
      },
      '/api/auth/get-session': () => SESSION,
    });
    render(withQuery(<DeviceScreen search="user_code=BAD" />));
    expect(await screen.findByText('Invalid or unavailable request')).toBeTruthy();
    expect(screen.queryByText('expired')).toBeNull();
  });
});
