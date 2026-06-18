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

type PatternType = 'INJECTION' | 'EXFILTRATION' | 'SHELL_COMMAND' | 'CODE_SECURITY' | 'SENSITIVE_FILE';

type PatternForm = {
  flags: string;
  label: string;
  pattern: string;
  type: PatternType;
};

function CreatePatternModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form, setForm] = useState<PatternForm>({
    flags: 'i',
    label: '',
    pattern: '',
    type: 'INJECTION',
  });
  const patternTypeOptions: Array<{ label: string; value: PatternType }> = [
    { label: 'Injection (skill content)', value: 'INJECTION' },
    { label: 'Exfiltration (skill content)', value: 'EXFILTRATION' },
    { label: 'Shell Command (bash tool)', value: 'SHELL_COMMAND' },
    { label: 'Code Security (diff review)', value: 'CODE_SECURITY' },
    { label: 'Sensitive File (writeFile block)', value: 'SENSITIVE_FILE' },
  ];
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
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as PatternType }))}
            value={form.type}
          >
            {patternTypeOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
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

function PatternSection({
  description,
  patterns,
  title,
}: {
  description?: string;
  patterns: ScannerPattern[];
  title: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <p className="mt-1 text-xs text-paper-400">{description}</p>}
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
  const shellCommand = patterns?.filter((p) => p.type === 'SHELL_COMMAND') ?? [];
  const codeSecurity = patterns?.filter((p) => p.type === 'CODE_SECURITY') ?? [];
  const sensitiveFile = patterns?.filter((p) => p.type === 'SENSITIVE_FILE') ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold">Scanner Patterns</h2>
          <p className="mt-1 text-sm text-paper-400">
            Regex patterns used across four scanning stages: skill content injection/exfiltration
            detection, shell command blocking in the agent workspace, and advisory code security
            findings fed to the security reviewer. Built-in patterns can be toggled but not deleted.
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
          <PatternSection
            description="Checked when custom skill content is saved. Detects attempts to override agent instructions."
            patterns={injection}
            title="Injection Patterns"
          />
          <PatternSection
            description="Checked when custom skill content is saved. Detects attempts to exfiltrate data via skill prompts."
            patterns={exfiltration}
            title="Exfiltration Patterns"
          />
          <PatternSection
            description="Checked before each bash tool invocation. Dangerous matches are soft-blocked — the agent receives an error and can self-correct."
            patterns={shellCommand}
            title="Shell Command Patterns"
          />
          <PatternSection
            description="Checked against added lines in the final diff. Findings are advisory — passed to the security reviewer agent as structured context."
            patterns={codeSecurity}
            title="Code Security Patterns"
          />
          <PatternSection
            description="Checked against file paths before each writeFile tool call. Matches are hard-blocked — the agent cannot write to the matched path."
            patterns={sensitiveFile}
            title="Sensitive File Patterns"
          />
        </>
      )}

      <CreatePatternModal onClose={() => setNewOpen(false)} open={newOpen} />
    </div>
  );
}
