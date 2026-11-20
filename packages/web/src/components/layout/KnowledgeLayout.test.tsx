// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KNOWLEDGE_PAGES } from '@/lib/navigation';
import { resetNavigation } from '@/test/mockNavigation';
import {
  ADMIN_PERMISSIONS,
  NO_PERMISSIONS,
  resetPermissions,
  setPermissions,
} from '@/test/permissions';
import { KnowledgeLayout } from './KnowledgeLayout';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
vi.mock('@/hooks/useEffectivePermissions', async () =>
  (await import('@/test/permissions')).permissionsMock()
);
afterEach(() => {
  cleanup();
  resetPermissions();
});

describe('KnowledgeLayout', () => {
  it.each(KNOWLEDGE_PAGES.map((page) => [page.href, page.label]))(
    'shares one header and activates %s, including sub-routes',
    (href, label) => {
      setPermissions(NO_PERMISSIONS);
      resetNavigation('', `${href}/detail`);
      render(
        <KnowledgeLayout>
          <p>Tab content and actions</p>
        </KnowledgeLayout>
      );
      expect(screen.getAllByRole('heading', { level: 1 }).map((node) => node.textContent)).toEqual([
        'Knowledge',
      ]);
      expect(screen.getByText(/Curated knowledge, repository-backed/)).toBeTruthy();
      const nav = screen.getByRole('navigation', { name: 'Knowledge sections' });
      expect(
        within(nav)
          .getAllByRole('link')
          .map((node) => node.getAttribute('href'))
      ).toEqual(KNOWLEDGE_PAGES.map((page) => page.href));
      expect(within(nav).getByRole('link', { name: label }).getAttribute('aria-current')).toBe(
        'page'
      );
      expect(nav.querySelectorAll('[aria-current="page"]').length).toBe(1);
      expect(screen.getByText('Tab content and actions')).toBeTruthy();
    }
  );

  it.each([
    ['a person with no standing', NO_PERMISSIONS],
    ['a platform admin', ADMIN_PERMISSIONS],
    ['a person whose permissions have not loaded', undefined],
  ])('renders every tab for %s: each page narrows itself', (_who, perms) => {
    setPermissions(perms);
    resetNavigation('', '/knowledge');
    render(
      <KnowledgeLayout>
        <p>Content</p>
      </KnowledgeLayout>
    );
    expect(screen.queryAllByRole('link').length).toBe(KNOWLEDGE_PAGES.length);
  });
});
