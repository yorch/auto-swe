// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/help/PageHelp', () => import('@/components/help/inlinePageHelp'));
vi.mock('next/navigation', () => ({
  usePathname: () => '/studio/models',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/audit/ConfigAuditLogTab', () => ({ ConfigAuditLogTab: () => null }));
vi.mock('@/components/modelConfig/CatalogTab', () => ({ CatalogTab: () => null }));
vi.mock('@/components/modelConfig/CredentialsTab', () => ({ CredentialsTab: () => null }));
vi.mock('@/components/modelConfig/EmbeddingsTab', () => ({ EmbeddingsTab: () => null }));
vi.mock('@/components/modelConfig/MidRunWarning', () => ({ MidRunWarning: () => null }));
vi.mock('@/components/setup/SetupReadiness', () => ({ SetupBanner: () => null }));

import StudioModelConfigPage from './page';

describe('Model configuration page', () => {
  it('tells the reader to add a provider credential first, and what breaks without one', () => {
    render(<StudioModelConfigPage />);
    expect(screen.getByText(/add a provider credential first/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'About model configuration' }).getAttribute('href')
    ).toBe('/docs/model-configuration');
  });
});
