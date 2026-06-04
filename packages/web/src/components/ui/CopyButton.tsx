'use client';

import { useState } from 'react';

interface CopyButtonProps {
  value: string;
  className?: string;
}

export function CopyButton({ value, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      className={`inline-flex items-center rounded-sm border border-ink-600 bg-ink-800 px-2 py-0.5 font-mono text-[10px] text-paper-400 transition-colors hover:border-ember-400 hover:text-ember-400 ${className ?? ''}`}
      onClick={handleCopy}
      title="Copy to clipboard"
      type="button"
    >
      {copied ? 'copied' : 'copy'}
    </button>
  );
}
