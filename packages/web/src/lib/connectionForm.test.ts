import { CONNECTION_TYPES } from '@auto-swe/shared/lib/connectionTypes';
import { describe, expect, it } from 'vitest';
import {
  initialConnectionType,
  parseConnectionConfig,
  selectableConnectionTypes,
} from './connectionForm';

describe('selectableConnectionTypes', () => {
  it('offers every gateway-accepted type except mcp', () => {
    const values = selectableConnectionTypes().map((t) => t.value);
    expect(values).toEqual(CONNECTION_TYPES.filter((t) => t !== 'mcp'));
    expect(values).not.toContain('api_endpoint');
    expect(values).not.toContain('generic');
  });
});

describe('initialConnectionType', () => {
  it('keeps a known non-git type when editing', () => {
    expect(initialConnectionType('notion')).toBe('notion');
    expect(initialConnectionType('http_api')).toBe('http_api');
  });
  it('falls back to git_repo for a missing or unknown type', () => {
    expect(initialConnectionType(undefined)).toBe('git_repo');
    expect(initialConnectionType('generic')).toBe('git_repo');
  });
});

describe('parseConnectionConfig', () => {
  it('treats blank as no config', () => {
    expect(parseConnectionConfig('  ')).toEqual({ config: null, ok: true });
  });
  it('parses an object', () => {
    expect(parseConnectionConfig('{"a":1}')).toEqual({ config: { a: 1 }, ok: true });
  });
  it('rejects invalid JSON and non-objects', () => {
    expect(parseConnectionConfig('{').ok).toBe(false);
    expect(parseConnectionConfig('[1]').ok).toBe(false);
    expect(parseConnectionConfig('null').ok).toBe(false);
  });
});
