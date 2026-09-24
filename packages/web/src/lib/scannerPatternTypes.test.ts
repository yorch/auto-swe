import { SCANNER_PATTERN_TYPES } from '@auto-swe/shared/bundle';
import { describe, expect, it } from 'vitest';
import {
  isScannerPatternType,
  SCANNER_PATTERN_TYPE_INFO,
  SCANNER_PATTERN_TYPE_ORDER,
} from './scannerPatternTypes';

describe('scanner pattern types', () => {
  it('covers every shared type, PII included', () => {
    expect([...SCANNER_PATTERN_TYPE_ORDER].sort()).toEqual([...SCANNER_PATTERN_TYPES].sort());
    expect(Object.keys(SCANNER_PATTERN_TYPE_INFO).sort()).toEqual(
      [...SCANNER_PATTERN_TYPES].sort()
    );
    expect(isScannerPatternType('PII')).toBe(true);
    expect(isScannerPatternType('toString')).toBe(false);
  });
});
