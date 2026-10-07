import { Button } from './Button';
import { Icon } from './Icon';

export function Pagination({
  hasNext,
  hasPrev,
  onNext,
  onPrev,
  rangeEnd,
  rangeStart,
  total,
}: {
  hasNext: boolean;
  hasPrev: boolean;
  onNext: () => void;
  onPrev: () => void;
  rangeEnd: number;
  rangeStart: number;
  total: number;
}) {
  if (total === 0) {
    return null;
  }
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between">
      <span className="tabular text-[13px] text-paper-400">
        {rangeStart}–{rangeEnd} of {total}
      </span>
      <div className="flex gap-2">
        <Button aria-label="Previous page" disabled={!hasPrev} onClick={onPrev} size="sm">
          <Icon className="rotate-180" name="chevronRight" size={14} />
          Previous
        </Button>
        <Button aria-label="Next page" disabled={!hasNext} onClick={onNext} size="sm">
          Next
          <Icon name="chevronRight" size={14} />
        </Button>
      </div>
    </nav>
  );
}
