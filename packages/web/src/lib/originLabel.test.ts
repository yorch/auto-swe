import { expect, it } from 'vitest';
import { originLabel } from './originLabel';

it('names the seeded starter and falls back to custom', () => {
  expect(originLabel(null)).toBe('Custom');
  expect(originLabel('swe-starter')).toBe('Engineering starter');
  expect(originLabel('acme-bundle')).toBe('acme-bundle');
});
