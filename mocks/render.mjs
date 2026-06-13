import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'url';
import path from 'path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const CHROME = '/root/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome';

// page -> capture mode. canvas/run/inbox are app-shell full-height; capture at fixed viewport.
const pages = [
  ['index', 1440, true],
  ['dashboard', 1440, false],
  ['canvas', 1500, false],
  ['run', 1440, false],
  ['inbox', 1440, false],
  ['packs', 1440, false],
  ['connections', 1440, false],
  ['analytics', 1440, false],
  ['memory', 1440, false],
  ['security', 1440, false],
  ['templates', 1440, false],
  ['admin', 1440, false],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'shell',
  args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-color-profile=srgb'],
});

for (const [name, width, fullPage] of pages) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 1000, deviceScaleFactor: 2 });
  await page.goto('file://' + path.join(dir, name + '.html'), { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 350));
  const out = path.join(dir, 'shots', name + '.png');
  await page.screenshot({ path: out, fullPage });
  console.log('shot:', name, fullPage ? '(full)' : '(viewport)');
  await page.close();
}

await browser.close();
console.log('done');
