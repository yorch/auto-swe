'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { DeviceScreen } from '@/components/oauth/DeviceScreen';

export default function DevicePage() {
  return (
    <Suspense fallback={null}>
      <DevicePageInner />
    </Suspense>
  );
}

function DevicePageInner() {
  return <DeviceScreen search={useSearchParams().toString()} />;
}
