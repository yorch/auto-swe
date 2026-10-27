import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SupportInfoFn = typeof import('./env').supportInfo;

function setSupport(values: { url?: string; email?: string; slack?: string }) {
  vi.stubEnv('NEXT_PUBLIC_SUPPORT_URL', values.url ?? '');
  vi.stubEnv('NEXT_PUBLIC_SUPPORT_EMAIL', values.email ?? '');
  vi.stubEnv('NEXT_PUBLIC_SUPPORT_SLACK', values.slack ?? '');
}

describe('supportInfo', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let supportInfo: SupportInfoFn;

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.resetModules();
    ({ supportInfo } = await import('./env'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    warn.mockRestore();
  });

  it('returns undefined when nothing is set', () => {
    setSupport({});
    expect(supportInfo()).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a valid https URL', () => {
    setSupport({ url: 'https://help.example.com/support' });
    expect(supportInfo()).toEqual({ url: 'https://help.example.com/support' });
  });

  it.each(['http://help.example.com', 'javascript:alert(1)', 'not a url'])(
    'drops the URL %s and warns once',
    (url) => {
      setSupport({ url });
      expect(supportInfo()).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps a valid email', () => {
    setSupport({ email: 'help@example.com' });
    expect(supportInfo()).toEqual({ email: 'help@example.com' });
  });

  it.each(['no-at-sign', 'a@b@c.com', 'a b@c.com', 'a<b>@c.com', 'a"b@c.com', "a'b@c.com"])(
    'drops the email %s',
    (email) => {
      setSupport({ email });
      expect(supportInfo()).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps Slack free text without a link', () => {
    setSupport({ slack: '#platform-help' });
    expect(supportInfo()).toEqual({ slack: { text: '#platform-help' } });
  });

  it('turns a Slack https URL into a link', () => {
    setSupport({ slack: 'https://acme.slack.com/archives/C123' });
    expect(supportInfo()).toEqual({
      slack: {
        href: 'https://acme.slack.com/archives/C123',
        text: 'https://acme.slack.com/archives/C123',
      },
    });
  });

  it('drops Slack text longer than 80 characters', () => {
    setSupport({ slack: 'x'.repeat(81) });
    expect(supportInfo()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps Slack text of exactly 80 characters', () => {
    setSupport({ slack: 'x'.repeat(80) });
    expect(supportInfo()).toEqual({ slack: { text: 'x'.repeat(80) } });
  });

  it('keeps valid fields and logs one warning for several invalid ones', () => {
    setSupport({ email: 'bad', slack: '#ok', url: 'http://x.com' });
    expect(supportInfo()).toEqual({ slack: { text: '#ok' } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns once per process for the same message across repeated reads', () => {
    setSupport({ url: 'http://x.com' });
    supportInfo();
    supportInfo();
    supportInfo();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns again for a different message', () => {
    setSupport({ url: 'http://x.com' });
    supportInfo();
    setSupport({ email: 'bad' });
    supportInfo();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('drops a support URL that carries credentials', () => {
    setSupport({ url: 'https://user:pw@help.example.com' });
    expect(supportInfo()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops a username-only support URL', () => {
    setSupport({ url: 'https://user@help.example.com' });
    expect(supportInfo()).toBeUndefined();
  });

  it('drops a Slack link that carries credentials instead of showing it as text', () => {
    setSupport({ slack: 'https://user:pw@acme.slack.com/archives/C1' });
    expect(supportInfo()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
