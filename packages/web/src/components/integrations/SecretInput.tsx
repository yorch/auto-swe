import type { MaskedField } from '@/hooks/useAdminConfig';

interface SecretInputProps {
  id: string;
  label: string;
  current: MaskedField | null | undefined;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

/**
 * Password input for a masked secret field.
 * Shows `••••{lastFour}` as placeholder when the field is already set in the backend.
 * When the user types, the real value is collected and sent on save.
 * If the user leaves it empty, the field is omitted from the PUT body (partial update).
 */
export function SecretInput({
  id,
  label,
  current,
  value,
  onChange,
  placeholder,
}: SecretInputProps) {
  const setPlaceholder = current ? `••••${current.lastFour}` : (placeholder ?? 'Enter value…');

  return (
    <div>
      <label className="mb-1 block text-xs uppercase text-paper-500" htmlFor={id}>
        {label}
        {current && (
          <span className="ml-2 font-mono text-[10px] normal-case tracking-normal text-paper-600">
            (leave blank to keep existing)
          </span>
        )}
      </label>
      <input
        autoComplete="off"
        className="w-full rounded-sm border border-ink-600 bg-ink-900 px-3 py-2 font-mono text-xs placeholder:text-paper-600 focus:border-ember-400 focus:outline-none"
        id={id}
        onChange={(e) => onChange(e.target.value)}
        placeholder={setPlaceholder}
        type="password"
        value={value}
      />
    </div>
  );
}
