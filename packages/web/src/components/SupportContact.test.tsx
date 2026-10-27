// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SupportInfo } from '@/lib/env';
import { SupportContact } from './SupportContact';

function configure(support?: SupportInfo) {
  (window as unknown as { __APP_CONFIG__?: unknown }).__APP_CONFIG__ = support
    ? { support }
    : undefined;
}

afterEach(() => {
  cleanup();
  configure(undefined);
});

describe('SupportContact', () => {
  it('renders nothing when no support value is set', () => {
    const { container } = render(<SupportContact />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when the config carries an empty support object', () => {
    configure({});
    const { container } = render(<SupportContact />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the support URL as an external link', () => {
    configure({ url: 'https://help.example.com/' });
    render(<SupportContact />);
    const link = screen.getByRole('link', { name: /help\.example\.com/ });
    expect(link.getAttribute('href')).toBe('https://help.example.com/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders the email as a mailto link and as text', () => {
    configure({ email: 'help@example.com' });
    render(<SupportContact />);
    const link = screen.getByRole('link', { name: 'help@example.com' });
    expect(link.getAttribute('href')).toBe('mailto:help@example.com');
  });

  it('encodes an address containing ?, & and % in the href and shows it as text', () => {
    const email = 'a?b&c%d@example.com';
    configure({ email });
    render(<SupportContact />);
    const link = screen.getByRole('link', { name: email });
    expect(link.getAttribute('href')).toBe('mailto:a%3Fb%26c%25d@example.com');
    expect(link.textContent).toBe(email);
  });

  it('cannot smuggle mailto header fields through the address', () => {
    configure({ email: 'a?bcc=evil@example.com' });
    render(<SupportContact />);
    const href = screen.getByRole('link').getAttribute('href') ?? '';
    expect(new URL(href).searchParams.has('bcc')).toBe(false);
  });

  it('renders Slack text as plain text when there is no href', () => {
    configure({ slack: { text: '#help-autoswe' } });
    render(<SupportContact />);
    expect(screen.getByText('#help-autoswe')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders Slack as an external link when an https href is given', () => {
    configure({ slack: { href: 'https://slack.example.com/c/help', text: '#help-autoswe' } });
    render(<SupportContact />);
    const link = screen.getByRole('link', { name: /#help-autoswe/ });
    expect(link.getAttribute('href')).toBe('https://slack.example.com/c/help');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('does not interpret markup in the Slack text', () => {
    configure({ slack: { text: '<b>bold</b>' } });
    const { container } = render(<SupportContact />);
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>bold</b>');
  });

  it('labels the group for assistive technology', () => {
    configure({ email: 'help@example.com' });
    render(<SupportContact />);
    expect(screen.getByRole('group', { name: 'Support' })).toBeTruthy();
  });
});
