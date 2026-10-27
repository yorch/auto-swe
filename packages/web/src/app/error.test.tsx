// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RouteError from './error';
import GlobalError from './global-error';
import NotFound from './not-found';

function configure(support?: unknown) {
  (window as unknown as { __APP_CONFIG__?: unknown }).__APP_CONFIG__ = support
    ? { support }
    : undefined;
}

afterEach(() => {
  cleanup();
  configure(undefined);
  vi.restoreAllMocks();
});

const failure = new Error('boom');

describe('route error screen', () => {
  it('shows the configured support contact', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    configure({ email: 'help@example.com' });
    render(<RouteError error={failure} reset={() => undefined} />);
    expect(screen.getByRole('link', { name: 'help@example.com' })).toBeTruthy();
  });

  it('adds no support element when nothing is configured', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<RouteError error={failure} reset={() => undefined} />);
    expect(screen.queryByRole('group', { name: 'Support' })).toBeNull();
    expect(screen.queryByText('Support')).toBeNull();
  });
});

describe('not-found screen', () => {
  it('shows the configured support contact', () => {
    configure({ url: 'https://help.example.com/' });
    render(<NotFound />);
    expect(screen.getByRole('link', { name: /help\.example\.com/ })).toBeTruthy();
  });

  it('adds no support element when nothing is configured', () => {
    render(<NotFound />);
    expect(screen.queryByRole('group', { name: 'Support' })).toBeNull();
    expect(screen.queryByText('Support')).toBeNull();
  });
});

describe('global error screen', () => {
  function renderGlobal() {
    // It renders its own <html>, so it mounts on the document rather than in a <div>.
    return render(<GlobalError error={failure} reset={() => undefined} />, {
      container: document,
    });
  }

  it('shows the support contact when the app config carries one', () => {
    configure({ email: 'help@example.com', url: 'https://help.example.com/' });
    renderGlobal();
    expect(screen.getByRole('link', { name: 'help@example.com' }).getAttribute('href')).toBe(
      'mailto:help@example.com'
    );
    expect(screen.getByRole('link', { name: /help\.example\.com/ }).getAttribute('rel')).toBe(
      'noopener noreferrer'
    );
  });

  it('renders without throwing when window.__APP_CONFIG__ is absent', () => {
    configure(undefined);
    expect(renderGlobal).not.toThrow();
    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.queryByText('Support')).toBeNull();
  });

  it('renders without throwing when the config has no support', () => {
    (window as unknown as { __APP_CONFIG__?: unknown }).__APP_CONFIG__ = { apiUrl: 'x' };
    expect(renderGlobal).not.toThrow();
    expect(screen.queryByText('Support')).toBeNull();
  });

  it('shows Slack text, and a Slack link when it has an https href', () => {
    configure({ slack: { href: 'https://slack.example.com/c/help', text: '#help' } });
    renderGlobal();
    expect(screen.getByRole('link', { name: /#help/ }).getAttribute('href')).toBe(
      'https://slack.example.com/c/help'
    );
  });

  it('does not throw when reading the config itself throws', () => {
    Object.defineProperty(window, '__APP_CONFIG__', {
      configurable: true,
      get() {
        throw new Error('hostile getter');
      },
    });
    try {
      expect(renderGlobal).not.toThrow();
      expect(screen.getByText('Something went wrong')).toBeTruthy();
    } finally {
      Reflect.deleteProperty(window, '__APP_CONFIG__');
    }
  });

  it.each([
    'nope',
    { email: 42, slack: 'x', url: {} },
    { email: 'a@b@c', slack: { text: 5 }, url: 'javascript:alert(1)' },
  ])('ignores a malformed support value %j', (value) => {
    configure(value);
    expect(renderGlobal).not.toThrow();
    expect(screen.queryByText('Support')).toBeNull();
  });
});
