import type { InputHTMLAttributes } from 'react';
import { FieldWrapper, fieldDescribedBy } from './FieldWrapper';

type SliderProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'value'> & {
  label: string;
  value: number;
  onChange: (value: number) => void;
  hint?: string;
  /** Formats the readout beside the track (`(v) => `${v}%``); defaults to the bare number. */
  formatValue?: (value: number) => string;
};

/** Native range input with its label and a live value readout. */
export function Slider({
  formatValue = String,
  hint,
  id,
  label,
  onChange,
  value,
  ...props
}: SliderProps) {
  const sliderId = id ?? props.name ?? label.toLowerCase().replace(/\s+/g, '-');
  return (
    <FieldWrapper hint={hint} id={sliderId} label={label}>
      <div className="flex items-center gap-3">
        <input
          aria-describedby={fieldDescribedBy(sliderId, hint, undefined)}
          aria-valuetext={formatValue(value)}
          className="h-1.5 flex-1 cursor-pointer accent-ember-400"
          id={sliderId}
          onChange={(e) => onChange(Number(e.target.value))}
          type="range"
          value={value}
          {...props}
        />
        <span className="min-w-10 text-right font-mono text-sm text-paper-100">
          {formatValue(value)}
        </span>
      </div>
    </FieldWrapper>
  );
}
