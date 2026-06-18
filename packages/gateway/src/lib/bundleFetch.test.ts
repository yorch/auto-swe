import { describe, expect, it } from 'vitest';
import { assertPublicBundleUrl } from './bundleFetch.js';

describe('assertPublicBundleUrl', () => {
  it('blocks loopback, link-local/metadata, and private hosts', () => {
    for (const url of [
      'http://localhost/x.json',
      'http://127.0.0.1/x.json',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/x.json',
      'http://172.16.4.4/x.json',
      'http://192.168.1.1/x.json',
      'http://[::1]/x.json',
    ]) {
      expect(() => assertPublicBundleUrl(url), url).toThrow(/private\/loopback/);
    }
  });

  it('allows a public host', () => {
    expect(() =>
      assertPublicBundleUrl('https://registry.example.com/swe.bundle.json')
    ).not.toThrow();
  });
});
