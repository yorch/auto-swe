'use client';

import type { RunDetailLayout } from '@auto-swe/shared/types/api';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/SegmentedControl';

const OPTIONS: SegmentedOption<RunDetailLayout>[] = [
  { label: 'Split', title: 'Split console: graph and console side by side', value: 'A' },
  { label: 'Transcript', title: 'Transcript: every step in order', value: 'B' },
  { label: 'Timeline', title: 'Flight recorder: timeline with replay', value: 'C' },
];

interface LayoutToggleProps {
  value: RunDetailLayout;
  onChange: (v: RunDetailLayout) => void;
}

export function LayoutToggle({ value, onChange }: LayoutToggleProps) {
  return (
    // On a phone the three options share the row and are 40px tall.
    <SegmentedControl
      ariaLabel="Run layout"
      className="max-w-full max-lg:flex max-lg:w-full"
      onChange={onChange}
      optionClassName="min-h-[40px] max-lg:flex-1 max-lg:px-1.5 lg:min-h-0"
      options={OPTIONS}
      value={value}
    />
  );
}
