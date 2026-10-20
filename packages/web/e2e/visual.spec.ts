import { expect, type Page, test } from '@playwright/test';
import { LOOKS, type Look, lookName, prepare, settle } from './support/harness';
import { SCREENS, type Screen } from './support/screens';

/**
 * Screenshot baselines for the dashboard's main screens, in every palette ×
 * theme at desktop width, plus a few at phone width. Each shot is the
 * viewport (the shell scrolls inside `<main>`, so a full-page shot would show
 * no more). Update the baselines on purpose with `yarn workspace @auto-swe/web
 * test:visual --update-snapshots` — see docs/architecture.md.
 */

const DESKTOP = { height: 900, width: 1280 };
const PHONE = { height: 844, width: 390 };
const PHONE_LOOK: Look = { palette: 'navy', theme: 'dark' };
const PHONE_SCREENS = ['home', 'runs', 'requests', 'approvals'];

async function shoot(page: Page, baseURL: string, screen: Screen, look: Look, file: string) {
  const unhandled = await prepare(page, baseURL, look);
  await page.goto(screen.path);
  await screen.ready(page);
  await settle(page);
  if (screen.act) {
    await screen.act(page);
    await settle(page);
  }
  expect(unhandled, 'every gateway call has a fixture').toEqual([]);
  await expect(page).toHaveScreenshot(file);
}

test.describe('desktop', () => {
  test.use({ viewport: DESKTOP });

  for (const screen of SCREENS) {
    for (const look of LOOKS) {
      test(`${screen.name} · ${lookName(look)}`, async ({ page, baseURL }) => {
        await shoot(page, baseURL ?? '', screen, look, `${screen.name}-${lookName(look)}.png`);
      });
    }
  }
});

test.describe('phone', () => {
  // A touch device: `hover: none`, so actions that wait for hover on a desktop show, as on a phone.
  test.use({ hasTouch: true, isMobile: true, viewport: PHONE });

  for (const name of PHONE_SCREENS) {
    const screen = SCREENS.find((s) => s.name === name);
    if (!screen) {
      throw new Error(`No screen named ${name}`);
    }
    test(`${name} · phone · ${lookName(PHONE_LOOK)}`, async ({ page, baseURL }) => {
      await shoot(
        page,
        baseURL ?? '',
        screen,
        PHONE_LOOK,
        `${name}-phone-${lookName(PHONE_LOOK)}.png`
      );
    });
  }
});
