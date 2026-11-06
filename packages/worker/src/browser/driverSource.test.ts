import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { BROWSER_DRIVER_SOURCE } from './driverSource.js';

describe('browser driver source', () => {
  it('matches the checked-in driver module', async () => {
    const source = await readFile(new URL('./driver.mjs', import.meta.url), 'utf8');
    expect(BROWSER_DRIVER_SOURCE).toBe(source);
  });
});
