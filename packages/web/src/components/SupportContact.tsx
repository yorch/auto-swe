'use client';

import type { ReactNode } from 'react';
import { useSupportInfo } from '@/hooks/useSupportInfo';
import { cn, FOCUS_RING } from '@/lib/utils';

const LINK_CLASS = cn(
  'rounded-sm text-paper-300 underline underline-offset-2 hover:text-paper-100',
  FOCUS_RING
);

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className={LINK_CLASS} href={href} rel="noopener noreferrer" target="_blank">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/** `?`, `&` and `#` in an address must not become mailto header fields (`?bcc=`), so each part is
 *  component-encoded; `@` stays literal. `encodeURI` would leave those characters alone. */
function mailtoHref(email: string): string {
  return `mailto:${email.split('@').map(encodeURIComponent).join('@')}`;
}

function displayUrl(url: string): string {
  try {
    const { host, pathname } = new URL(url);
    return pathname === '/' ? host : `${host}${pathname}`;
  } catch {
    return url;
  }
}

/**
 * The operator-configured support contacts. Renders nothing when none is set,
 * so it adds no empty container or heading. Values are validated server-side
 * and rendered only as text nodes and attribute values.
 */
export function SupportContact({ className }: { className?: string }) {
  const support = useSupportInfo();
  if (!support || (!support.url && !support.email && !support.slack)) {
    return null;
  }
  const { url, email, slack } = support;
  return (
    <address
      aria-label="Support"
      className={cn('text-xs not-italic leading-relaxed break-words text-paper-500', className)}
    >
      <span className="font-medium text-paper-400">Support</span>
      <ul className="mt-0.5 space-y-0.5">
        {url && (
          <li>
            <ExternalLink href={url}>{displayUrl(url)}</ExternalLink>
          </li>
        )}
        {email && (
          <li>
            <a className={LINK_CLASS} href={mailtoHref(email)}>
              {email}
            </a>
          </li>
        )}
        {slack && (
          <li>
            {slack.href ? (
              <ExternalLink href={slack.href}>{slack.text}</ExternalLink>
            ) : (
              <span>{slack.text}</span>
            )}
          </li>
        )}
      </ul>
    </address>
  );
}
