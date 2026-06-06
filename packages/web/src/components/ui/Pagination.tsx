const BTN =
  'rounded-sm border border-ink-500 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-paper-200 hover:border-ember-400 disabled:cursor-not-allowed disabled:opacity-40';

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
  return (
    <div className="flex items-center justify-between">
      <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
        {rangeStart}–{rangeEnd} of {total}
      </span>
      <div className="flex gap-2">
        <button className={BTN} disabled={!hasPrev} onClick={onPrev} type="button">
          ← Prev
        </button>
        <button className={BTN} disabled={!hasNext} onClick={onNext} type="button">
          Next →
        </button>
      </div>
    </div>
  );
}
