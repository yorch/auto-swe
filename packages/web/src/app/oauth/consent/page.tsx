'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ConsentScreen } from '@/components/oauth/ConsentScreen';

// useSearchParams() needs a Suspense boundary above it for the page to stay prerenderable.
export default function OAuthConsentPage() {
  return (
    <Suspense fallback={null}>
      <ConsentPageInner />
    </Suspense>
  );
}

function ConsentPageInner() {
  return <ConsentScreen search={useSearchParams().toString()} />;
}
