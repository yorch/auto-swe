'use client';

import { useServerInsertedHTML } from 'next/navigation';
import { createElement, useRef } from 'react';

interface AppConfigScriptProps {
  appConfig: string;
}

export function AppConfigScript({ appConfig }: AppConfigScriptProps) {
  const inserted = useRef(false);

  useServerInsertedHTML(() => {
    if (inserted.current) {
      return null;
    }
    inserted.current = true;

    return createElement('script', {
      dangerouslySetInnerHTML: { __html: `window.__APP_CONFIG__=${appConfig};` },
      id: '__APP_CONFIG__',
    });
  });

  return null;
}
