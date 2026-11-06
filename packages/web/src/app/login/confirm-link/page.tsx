'use client';

import { useEffect, useState } from 'react';
import { AuthHeading, AuthLayout } from '@/components/layout/AuthLayout';
import { Button, ButtonLink } from '@/components/ui/Button';
import { type EmailedLink, magicLinkVerifyUrl, readEmailedLink } from '@/lib/magicLinkConfirm';

/**
 * Where a magic sign-in email lands. Opening it spends nothing, so a mail scanner that fetches
 * the link leaves it usable; the token is spent only when the user clicks "Sign in".
 */
export default function ConfirmMagicLinkPage() {
  const [link, setLink] = useState<EmailedLink | null | undefined>(undefined);

  useEffect(() => {
    setLink(readEmailedLink(window.location.hash));
  }, []);

  if (link === undefined) {
    return null;
  }
  if (link === null) {
    return (
      <AuthLayout>
        <div role="alert">
          <AuthHeading icon="warning" title="This sign-in link is not valid" tone="warning">
            Request a new link from the sign-in page.
          </AuthHeading>
        </div>
        <ButtonLink className="w-full" href="/login" size="lg" variant="primary">
          Go to sign in
        </ButtonLink>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout>
      <AuthHeading icon="key" title="Confirm sign-in">
        The link works once and expires 10 minutes after it was sent.
      </AuthHeading>
      <Button
        className="w-full"
        onClick={() => window.location.assign(magicLinkVerifyUrl(link))}
        size="lg"
        variant="primary"
      >
        {link.email ? `Sign in as ${link.email}` : 'Sign in'}
      </Button>
    </AuthLayout>
  );
}
