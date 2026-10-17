import { expect, type Page } from '@playwright/test';

/** One screen the suite shoots. */
export interface Screen {
  name: string;
  path: string;
  /** Resolves once the screen's own content (not a skeleton) is on the page. */
  ready: (page: Page) => Promise<void>;
  /** Interaction that opens the state being shot (a dialog, a panel). */
  act?: (page: Page) => Promise<void>;
}

const heading = (page: Page, name: string) =>
  expect(page.getByRole('heading', { level: 1, name })).toBeVisible();

export const SCREENS: Screen[] = [
  {
    name: 'home',
    path: '/',
    ready: async (page) => {
      await heading(page, 'Home');
      await expect(page.getByText('PAY-1423').first()).toBeVisible();
    },
  },
  {
    name: 'runs',
    path: '/runs',
    ready: async (page) => {
      await heading(page, 'All runs');
      await expect(page.getByText('Upgrade pgx to v6').first()).toBeVisible();
    },
  },
  {
    name: 'run-detail-failed',
    path: '/runs/run-0001',
    ready: async (page) => {
      await expect(page.getByText('Retry idempotent refunds').first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Jump to the failed step' })).toBeVisible();
      await expect(page.locator('.react-flow__node').first()).toBeVisible();
    },
  },
  {
    name: 'requests',
    path: '/requests',
    ready: async (page) => {
      await heading(page, 'Requests');
      await expect(page.getByText('PAY-1423').first()).toBeVisible();
    },
  },
  {
    name: 'library',
    path: '/library',
    ready: async (page) => {
      await heading(page, 'Workflow library');
      await expect(page.getByText('Dependency upgrade').first()).toBeVisible();
    },
  },
  {
    name: 'template-editor',
    path: '/library/tpl-ticket-to-pull-request',
    ready: async (page) => {
      await heading(page, 'Ticket to pull request');
      await expect(page.locator('.react-flow__node').first()).toBeVisible();
    },
  },
  {
    name: 'approvals',
    path: '/approvals',
    ready: async (page) => {
      await expect(page.getByText('Approve the plan for LED-88').first()).toBeVisible();
    },
  },
  {
    name: 'model-catalog',
    path: '/models?tab=catalog',
    ready: async (page) => {
      await expect(page.getByText('claude-sonnet-5-5').first()).toBeVisible();
    },
  },
  {
    name: 'admin-users',
    path: '/admin/users',
    ready: async (page) => {
      await expect(page.getByText('grace.hopper@example.com').first()).toBeVisible();
    },
  },
  {
    name: 'settings',
    path: '/settings',
    ready: async (page) => {
      await heading(page, 'Settings');
      await expect(page.getByText('Local CLI').first()).toBeVisible();
    },
  },
  {
    act: async (page) => {
      await page
        .getByRole('button', { name: /Search/ })
        .first()
        .click();
      const input = page.getByRole('combobox', { name: 'Search pages' });
      await input.fill('refund');
      await expect(
        page.getByRole('option', { name: /Retry idempotent refunds/ }).first()
      ).toBeVisible();
    },
    name: 'command-palette',
    path: '/runs',
    ready: async (page) => {
      await heading(page, 'All runs');
      await expect(page.getByText('Upgrade pgx to v6').first()).toBeVisible();
    },
  },
  {
    act: async (page) => {
      await page.getByRole('button', { name: 'Help for this page' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
    },
    name: 'help-panel',
    path: '/runs',
    ready: async (page) => {
      await heading(page, 'All runs');
      await expect(page.getByText('Upgrade pgx to v6').first()).toBeVisible();
    },
  },
];
