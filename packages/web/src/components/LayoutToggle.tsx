'use client';

import type { RunDetailLayout } from '@auto-swe/shared/types/api';
import { SegmentedControl, type SegmentedOption } from '@/components/ui/SegmentedControl';

const OPTIONS: SegmentedOption<RunDetailLayout>[] = [
  { label: 'A', title: 'Split Console', value: 'A' },
  { label: 'B', title: 'Transcript', value: 'B' },
  { label: 'C', title: 'Flight Recorder', value: 'C' },
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
