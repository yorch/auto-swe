'use client';

import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { WORK_SCOPE_OPTIONS } from '@/lib/workScope';

export function WorkScopeControl({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: 'MINE' | 'TEAM') => void;
  value: 'MINE' | 'TEAM';
}) {
  return (
    <SegmentedControl
      ariaLabel={label}
      onChange={onChange}
      options={WORK_SCOPE_OPTIONS}
      value={value}
    />
  );
}
