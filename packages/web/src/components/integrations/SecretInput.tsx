import { Input } from '@/components/ui/Input';
import type { ConfigSource, MaskedField } from '@/hooks/useAdminConfig';
import { ConfigField } from './ConfigField';

interface SecretInputProps {
  id: string;
  label: string;
  current: MaskedField | null | undefined;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  source?: ConfigSource;
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
  source,
}: SecretInputProps) {
  const setPlaceholder = current ? `••••${current.lastFour}` : (placeholder ?? 'Enter value…');

  return (
    <ConfigField
      id={id}
      label={label}
      note={current ? '(leave blank to keep existing)' : undefined}
      source={source}
    >
      <Input
        autoComplete="off"
        compact
        id={id}
        onChange={(e) => onChange(e.target.value)}
        placeholder={setPlaceholder}
        type="password"
        value={value}
      />
    </ConfigField>
  );
}
