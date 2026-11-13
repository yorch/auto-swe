import { describe, expect, it } from 'vitest';
import { isRunTrigger, RUN_TRIGGERS } from './runTrigger.js';

describe('isRunTrigger', () => {
  it('accepts every listed trigger', () => {
    for (const trigger of RUN_TRIGGERS) {
      expect(isRunTrigger(trigger)).toBe(true);
    }
  });

  it('refuses anything else', () => {
    expect(isRunTrigger('cron')).toBe(false);
    expect(isRunTrigger('')).toBe(false);
    expect(isRunTrigger(undefined)).toBe(false);
    expect(isRunTrigger(3)).toBe(false);
  });
});
