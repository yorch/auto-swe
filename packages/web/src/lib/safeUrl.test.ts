import { describe, expect, it } from 'vitest';
import { safeHttpUrl } from './safeUrl';

describe('safeHttpUrl', () => {
  it('passes http and https and nothing else', () => {
    expect(safeHttpUrl('https://jira.test/browse/A-1')).toBe('https://jira.test/browse/A-1');
    expect(safeHttpUrl('http://jira.test/A-1')).toBe('http://jira.test/A-1');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });
});
