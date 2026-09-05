'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { FieldWrapper } from '@/components/ui/FieldWrapper';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  type ScannerPattern,
  useCreateScannerPattern,
  useDeleteScannerPattern,
  useScannerPatterns,
  useUpdateScannerPattern,
} from '@/hooks/useAdmin';
import { errMsg } from '@/lib/errors';
import { formatDate } from '@/lib/utils';

type PatternType =
  | 'INJECTION'
  | 'EXFILTRATION'
  | 'SHELL_COMMAND'
  | 'CODE_SECURITY'
  | 'SENSITIVE_FILE';

const patternTypeOptions: Array<{ label: string; value: PatternType }> = [
  { label: 'Injection (skill content)', value: 'INJECTION' },
  { label: 'Exfiltration (skill content)', value: 'EXFILTRATION' },
  { label: 'Shell Command (bash tool)', value: 'SHELL_COMMAND' },
  { label: 'Code Security (diff review)', value: 'CODE_SECURITY' },
  { label: 'Sensitive File (writeFile block)', value: 'SENSITIVE_FILE' },
];

// ── Create Modal ─────────────────────────────────────────────────────────────

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
      setError(errMsg(err, 'Failed to create pattern'));
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

// ── Pattern Detail / Edit Modal ───────────────────────────────────────────────

function PatternDetailModal({
  onClose,
  pattern,
}: {
  onClose: () => void;
  pattern: ScannerPattern | null;
}) {
  const update = useUpdateScannerPattern();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    flags: '',
    label: '',
    pattern: '',
    type: 'INJECTION' as PatternType,
  });
  const [error, setError] = useState<string | null>(null);

  if (!pattern) {
    return null;
  }

  const pat = pattern;

  function startEdit() {
    setForm({
      flags: pat.flags,
      label: pat.label,
      pattern: pat.pattern,
      type: pat.type as PatternType,
    });
    setError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update.mutateAsync({ id: pat.id, ...form });
      setEditing(false);
      onClose();
    } catch (err) {
      setError(errMsg(err, 'Failed to save pattern'));
    }
  }

  const title = editing ? `Edit "${pattern.label}"` : pattern.label;

  return (
    <Modal
      eyebrow="Admin / Scanner"
      onClose={() => {
        setEditing(false);
        onClose();
      }}
      open={!!pattern}
      size="lg"
      title={title}
    >
      {editing ? (
        <form className="space-y-4" onSubmit={handleSave}>
          <FieldWrapper label="Label">
            <Input
              onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
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
              value={form.flags}
            />
          </FieldWrapper>
          {error && <p className="text-xs text-brick-400">{error}</p>}
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={cancelEdit} type="button" variant="ghost">
              Cancel
            </Button>
            <Button disabled={update.isPending} type="submit" variant="primary">
              {update.isPending ? 'Saving…' : 'Save Changes'}
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap gap-2 text-xs">
            {pattern.isBuiltIn && (
              <span className="rounded bg-ink-600 px-2 py-0.5 font-mono uppercase tracking-wider text-paper-400">
                built-in
              </span>
            )}
            {pattern.origin && (
              <span className="rounded bg-ink-600 px-2 py-0.5 font-mono text-paper-400">
                origin: {pattern.origin}
              </span>
            )}
            <span className="rounded bg-ink-600 px-2 py-0.5 font-mono text-paper-400">
              {patternTypeOptions.find((o) => o.value === pattern.type)?.label ?? pattern.type}
            </span>
            <span
              className={`rounded px-2 py-0.5 font-mono ${
                pattern.isActive ? 'bg-ember-900/40 text-ember-400' : 'bg-ink-600 text-paper-500'
              }`}
            >
              {pattern.isActive ? 'active' : 'inactive'}
            </span>
          </div>

          <div>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wider text-paper-500">
              Regex Pattern
            </div>
            <pre className="overflow-x-auto rounded-sm border border-ink-600 bg-ink-800 p-3 font-mono text-sm text-paper-200 whitespace-pre-wrap break-all">
              /{pattern.pattern}/{pattern.flags}
            </pre>
          </div>

          <div className="flex items-center justify-between border-t border-ink-700 pt-4">
            <div className="space-y-0.5 text-xs text-paper-500">
              <div>Created {formatDate(pattern.createdAt)}</div>
              <div>Updated {formatDate(pattern.updatedAt)}</div>
            </div>
            {!pattern.isBuiltIn && (
              <Button onClick={startEdit} variant="secondary">
                Edit
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Pattern Row ───────────────────────────────────────────────────────────────

function PatternRow({ pattern }: { pattern: ScannerPattern }) {
  const update = useUpdateScannerPattern();
  const [viewTarget, setViewTarget] = useState<ScannerPattern | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScannerPattern | null>(null);
  const deletePattern = useDeleteScannerPattern();

  function toggleActive() {
    update.mutate({ id: pattern.id, isActive: !pattern.isActive });
  }

  return (
    <>
      <TRow>
        <Td className="py-2 pr-4">
          <button
            className="text-left font-mono text-xs text-paper-100 hover:underline"
            onClick={() => setViewTarget(pattern)}
            type="button"
          >
            {pattern.label}
          </button>
          {pattern.origin && (
            <span className="ml-1.5 rounded bg-ink-600 px-1 py-0.5 font-mono text-[10px] text-paper-400">
              {pattern.origin}
            </span>
          )}
        </Td>
        <Td className="max-w-xs py-2 pr-4">
          <code className="block truncate font-mono text-[11px] text-paper-300">
            /{pattern.pattern}/{pattern.flags}
          </code>
        </Td>
        <Td className="py-2 pr-4">
          {pattern.isBuiltIn && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-paper-500">
              built-in
            </span>
          )}
        </Td>
        <Td className="py-2 pr-4">
          <ToggleSwitch
            checked={pattern.isActive}
            disabled={update.isPending}
            onChange={toggleActive}
          />
        </Td>
        <Td className="py-2 text-right">
          <div className="flex items-center justify-end gap-2">
            <Button onClick={() => setViewTarget(pattern)} size="sm" variant="ghost">
              View
            </Button>
            {!pattern.isBuiltIn && (
              <Button onClick={() => setDeleteTarget(pattern)} size="sm" variant="danger">
                Delete
              </Button>
            )}
          </div>
        </Td>
      </TRow>
      <PatternDetailModal onClose={() => setViewTarget(null)} pattern={viewTarget} />
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message="This will permanently remove the scanner pattern. This cannot be undone."
        onClose={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (deleteTarget) {
            await deletePattern.mutateAsync(deleteTarget.id);
          }
        }}
        open={deleteTarget !== null}
        pendingLabel="Deleting…"
        title={`Delete "${deleteTarget?.label ?? ''}"?`}
      />
    </>
  );
}

// ── Pattern Section ───────────────────────────────────────────────────────────

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
        <Table>
          <THead>
            <Th variant="compact">Label</Th>
            <Th variant="compact">Pattern / Flags</Th>
            <Th variant="compact">Built-in</Th>
            <Th variant="compact">Active</Th>
            <Th variant="compact" />
          </THead>
          <tbody>
            {patterns.map((p) => (
              <PatternRow key={p.id} pattern={p} />
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function GovernScannerPage() {
  const [newOpen, setNewOpen] = useState(false);
  const { data: patterns, isLoading, isError, error: loadError } = useScannerPatterns();

  const injection = patterns?.filter((p) => p.type === 'INJECTION') ?? [];
  const exfiltration = patterns?.filter((p) => p.type === 'EXFILTRATION') ?? [];
  const shellCommand = patterns?.filter((p) => p.type === 'SHELL_COMMAND') ?? [];
  const codeSecurity = patterns?.filter((p) => p.type === 'CODE_SECURITY') ?? [];
  const sensitiveFile = patterns?.filter((p) => p.type === 'SENSITIVE_FILE') ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            + New Pattern
          </Button>
        }
        subtitle="Regex patterns used across four scanning stages: skill content injection/exfiltration detection, shell command blocking in the agent workspace, and advisory code security findings fed to the security reviewer. Built-in patterns can be toggled but not deleted."
        title="Scanner Patterns"
      />

      <QueryBoundary
        error={loadError}
        isError={isError}
        isLoading={isLoading}
        label="scanner patterns"
      >
        {
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
        }
      </QueryBoundary>

      <CreatePatternModal onClose={() => setNewOpen(false)} open={newOpen} />
    </div>
  );
}
