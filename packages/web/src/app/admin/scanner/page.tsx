'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { LoadingState } from '@/components/ui/LoadingState';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import {
  type ScannerPattern,
  useCreateScannerPattern,
  useDeleteScannerPattern,
  useScannerPatterns,
  useUpdateScannerPattern,
} from '@/hooks/useAdmin';

type PatternForm = {
  flags: string;
  label: string;
  pattern: string;
  type: 'INJECTION' | 'EXFILTRATION';
};

function CreatePatternModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState<PatternForm>({
    flags: 'i',
    label: '',
    pattern: '',
    type: 'INJECTION',
  });
  const [error, setError] = useState<string | null>(null);
  const create = useCreateScannerPattern();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await create.mutateAsync(form);
      onClose();
      setForm({ flags: 'i', label: '', pattern: '', type: 'INJECTION' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create pattern');
    }
  }

  return (
    <Modal eyebrow="Admin / Scanner" onClose={onClose} open={open} title="New Scanner Pattern">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <FieldWrapper label="Label">
          <Input
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            placeholder="my-custom-pattern"
            required
            value={form.label}
          />
        </FieldWrapper>
        <FieldWrapper label="Type">
          <Select
            onChange={(e) =>
              setForm((f) => ({ ...f, type: e.target.value as 'INJECTION' | 'EXFILTRATION' }))
            }
            value={form.type}
          >
            <option value="INJECTION">Injection</option>
            <option value="EXFILTRATION">Exfiltration</option>
          </Select>
        </FieldWrapper>
        <FieldWrapper label="Pattern (regex source)">
          <Input
            onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
            placeholder="my\s+pattern"
            required
            value={form.pattern}
          />
        </FieldWrapper>
        <FieldWrapper
          hint="Leave blank for no flags. Common: i (case-insensitive), m (multiline)"
          label="Flags"
        >
          <Input
            maxLength={10}
            onChange={(e) => setForm((f) => ({ ...f, flags: e.target.value }))}
            placeholder="i"
            value={form.flags}
          />
        </FieldWrapper>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button onClick={onClose} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={create.isPending} type="submit" variant="primary">
            {create.isPending ? 'Creating…' : 'Create Pattern'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeletePatternModal({
  onClose,
  pattern,
}: {
  onClose: () => void;
  pattern: ScannerPattern | null;
}) {
  const del = useDeleteScannerPattern();
  const [error, setError] = useState<string | null>(null);

  if (!pattern) {
    return null;
  }

  async function handleDelete() {
    if (!pattern) {
      return;
    }
    setError(null);
    try {
      await del.mutateAsync(pattern.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete pattern');
    }
  }

  return (
    <Modal onClose={onClose} open={!!pattern} title={`Delete "${pattern.label}"?`}>
      <div className="space-y-4">
        <p className="text-sm text-paper-400">
          This will permanently remove the scanner pattern. This cannot be undone.
        </p>
        {error && <p className="text-xs text-brick-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={del.isPending} onClick={handleDelete} variant="danger">
            {del.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function PatternRow({ pattern }: { pattern: ScannerPattern }) {
  const update = useUpdateScannerPattern();
  const [deleteTarget, setDeleteTarget] = useState<ScannerPattern | null>(null);

  function toggleActive() {
    update.mutate({ id: pattern.id, isActive: !pattern.isActive });
  }

  return (
    <>
      <tr className="border-b border-ink-600 last:border-0">
        <td className="py-2 pr-4 font-mono text-xs text-paper-100">{pattern.label}</td>
        <td className="max-w-xs py-2 pr-4">
          <code className="block truncate font-mono text-[11px] text-paper-300">
            /{pattern.pattern}/{pattern.flags}
          </code>
        </td>
        <td className="py-2 pr-4">
          {pattern.isBuiltIn && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
              built-in
            </span>
          )}
        </td>
        <td className="py-2 pr-4">
          <button
            className={`h-5 w-10 rounded-full transition-colors ${
              pattern.isActive ? 'bg-ember-400' : 'bg-ink-500'
            }`}
            disabled={update.isPending}
            onClick={toggleActive}
            title={pattern.isActive ? 'Disable' : 'Enable'}
            type="button"
          >
            <span
              className={`block h-4 w-4 translate-x-0.5 rounded-full bg-paper-100 transition-transform ${
                pattern.isActive ? 'translate-x-[1.375rem]' : ''
              }`}
            />
          </button>
        </td>
        <td className="py-2 text-right">
          {!pattern.isBuiltIn && (
            <Button onClick={() => setDeleteTarget(pattern)} size="sm" variant="danger">
              Delete
            </Button>
          )}
        </td>
      </tr>
      <DeletePatternModal onClose={() => setDeleteTarget(null)} pattern={deleteTarget} />
    </>
  );
}

function PatternSection({ patterns, title }: { patterns: ScannerPattern[]; title: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      {patterns.length === 0 ? (
        <div className="py-4 text-center text-sm text-paper-400">No patterns in this category.</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-ink-600">
              <th className="py-2 text-left text-xs text-paper-500">Label</th>
              <th className="py-2 text-left text-xs text-paper-500">Pattern / Flags</th>
              <th className="py-2 text-left text-xs text-paper-500">Built-in</th>
              <th className="py-2 text-left text-xs text-paper-500">Active</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {patterns.map((p) => (
              <PatternRow key={p.id} pattern={p} />
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export default function AdminScannerPage() {
  const [newOpen, setNewOpen] = useState(false);
  const { data: patterns, isLoading } = useScannerPatterns();

  const injection = patterns?.filter((p) => p.type === 'INJECTION') ?? [];
  const exfiltration = patterns?.filter((p) => p.type === 'EXFILTRATION') ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Scanner Patterns</h2>
          <p className="mt-1 text-sm text-paper-400">
            Regex patterns used to detect prompt-injection and data-exfiltration attempts in custom
            skill content. Built-in patterns can be toggled but not deleted. Custom patterns can be
            added, toggled, and deleted.
          </p>
        </div>
        <Button onClick={() => setNewOpen(true)} variant="primary">
          + New Pattern
        </Button>
      </div>

      {isLoading ? (
        <LoadingState />
      ) : (
        <>
          <PatternSection patterns={injection} title="Injection Patterns" />
          <PatternSection patterns={exfiltration} title="Exfiltration Patterns" />
        </>
      )}

      <CreatePatternModal onClose={() => setNewOpen(false)} open={newOpen} />
    </div>
  );
}
