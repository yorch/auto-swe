import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { COOKIE_SESSION_MARKER } from '@/lib/config';
import { proxy } from './proxy';

const req = (path: string, withMarker = false) =>
  new NextRequest(`http://localhost:3000${path}`, {
    headers: withMarker ? { cookie: `${COOKIE_SESSION_MARKER}=1` } : {},
  });

describe('proxy', () => {
  it('sends an unauthenticated request for an ordinary page to the login page', () => {
    const res = proxy(req('/settings'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/login?redirect=%2Fsettings');
  });

  it('lets the consent page load without the session marker, so a social sign-in can land on it', () => {
    const res = proxy(req('/oauth/consent?client_id=c1&sig=abc'));
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('forbids framing the consent and login pages, with or without a session', () => {
    for (const res of [
      proxy(req('/oauth/consent?client_id=c1')),
      proxy(req('/oauth/consent', true)),
      proxy(req('/login')),
    ]) {
      expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
  });

  it('leaves other pages frameable, as before', () => {
    const res = proxy(req('/settings', true));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
  });
});
