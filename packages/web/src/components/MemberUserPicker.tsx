'use client';

import { useEffect, useState } from 'react';
import { EligibleUserSelect } from '@/components/EligibleUserSelect';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { useHasRole } from '@/hooks/useHasRole';
import { lookupUserByEmail, useEligibleUsers } from '@/hooks/useUsers';
import { errMsg } from '@/lib/errors';

/**
 * The user field of an "add member" flow. An ADMIN picks from the directory;
 * anyone else (a LEAD adding to their team or organization) cannot list users,
 * so they look one up by exact email instead. Either way the chosen user's id
 * comes back through `onChange`; `''` means nothing is selected yet.
 */
export function MemberUserPicker({
  existingUserIds,
  value,
  onChange,
  label = 'User',
  id = 'user',
}: {
  existingUserIds: string[];
  value: string;
  onChange: (userId: string) => void;
  label?: string;
  id?: string;
}) {
  const isAdmin = useHasRole('ADMIN');
  const eligible = useEligibleUsers(existingUserIds, isAdmin);

  // Admin mode: default to the first eligible user, and drop a selection a
  // refetch removed from the list.
  const firstEligible = eligible[0]?.id ?? '';
  const selectionValid = eligible.some((u) => u.id === value);
  useEffect(() => {
    if (isAdmin && !selectionValid) {
      onChange(firstEligible);
    }
  }, [isAdmin, selectionValid, firstEligible, onChange]);

  const [email, setEmail] = useState('');
  const [found, setFound] = useState<string | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);

  if (isAdmin) {
    return (
      <EligibleUserSelect
        eligible={eligible}
        id={id}
        label={label}
        onChange={onChange}
        value={value}
      />
    );
  }

  async function handleLookup() {
    setLookupError(null);
    setFound(null);
    onChange('');
    const trimmed = email.trim();
    if (!trimmed) {
      setLookupError('Enter an email address');
      return;
    }
    setLooking(true);
    try {
      const user = await lookupUserByEmail(trimmed);
      if (existingUserIds.includes(user.id)) {
        setLookupError(`${user.email} is already a member`);
        return;
      }
      setFound(user.name ? `${user.email} · ${user.name}` : user.email);
      onChange(user.id);
    } catch (err) {
      setLookupError(errMsg(err, 'No active user with that email'));
    } finally {
      setLooking(false);
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex items-end gap-2">
        <Input
          id={id}
          label={label}
          onChange={(e) => {
            setEmail(e.target.value);
            if (value) {
              onChange('');
              setFound(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleLookup();
            }
          }}
          placeholder="colleague@example.com"
          type="email"
          value={email}
        />
        <Button disabled={looking} onClick={handleLookup} type="button" variant="secondary">
          {looking ? 'Finding…' : 'Find'}
        </Button>
      </div>
      {found && value && <p className="text-xs text-moss-400">✓ {found}</p>}
      {lookupError && <p className="text-xs text-brick-400">{lookupError}</p>}
    </div>
  );
}
