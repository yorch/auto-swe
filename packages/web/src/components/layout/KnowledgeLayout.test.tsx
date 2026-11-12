// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KNOWLEDGE_PAGES } from '@/lib/navigation';
import { useAuthStore } from '@/stores/authStore';
import { resetNavigation } from '@/test/mockNavigation';
import { KnowledgeLayout } from './KnowledgeLayout';

vi.mock('next/navigation', async () => (await import('@/test/mockNavigation')).navigationMock());
afterEach(cleanup);

describe('KnowledgeLayout', () => {
  it.each(KNOWLEDGE_PAGES.map((page) => [page.href, page.label]))(
    'shares one header and activates %s, including sub-routes',
    (href, label) => {
      useAuthStore.setState({ user: { role: 'ENGINEER' } } as never);
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

  it.each(['ENGINEER', 'LEAD', 'ADMIN', 'unknown', undefined])(
    'renders only tabs accessible to %s',
    (role) => {
      useAuthStore.setState({ user: role ? { role } : null } as never);
      resetNavigation('', '/knowledge');
      render(
        <KnowledgeLayout>
          <p>Content</p>
        </KnowledgeLayout>
      );
      expect(screen.queryAllByRole('link').length).toBe(
        ['ENGINEER', 'LEAD', 'ADMIN'].includes(role ?? '') ? 3 : 0
      );
    }
  );
});
