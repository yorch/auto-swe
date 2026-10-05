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
    <SegmentedControl ariaLabel="Run layout" onChange={onChange} options={OPTIONS} value={value} />
  );
}
