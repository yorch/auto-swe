'use client';

import { useState } from 'react';
import { EntityMetaBadges } from '@/components/library/EntityMetaBadges';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
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
    <Modal onClose={onClose} open={open} title="New scanner pattern">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <Input
          id="scanner-new-label"
          label="Label"
          onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
          placeholder="my-custom-pattern"
          required
          value={form.label}
        />
        <Select
          id="scanner-new-type"
          label="Type"
          onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as PatternType }))}
          value={form.type}
        >
          {patternTypeOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
        <Input
          id="scanner-new-pattern"
          label="Pattern (regex source)"
          onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
          placeholder="my\s+pattern"
          required
          value={form.pattern}
        />
        <Input
          hint="Leave blank for no flags. Common: i (case-insensitive), m (multiline)"
          id="scanner-new-flags"
          label="Flags"
          maxLength={10}
          onChange={(e) => setForm((f) => ({ ...f, flags: e.target.value }))}
          placeholder="i"
          value={form.flags}
        />
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          isPending={create.isPending}
          onCancel={onClose}
          pendingLabel="Creating…"
          submitLabel="Create pattern"
        />
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
          <Input
            id="scanner-edit-label"
            label="Label"
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            required
            value={form.label}
          />
          <Select
            id="scanner-edit-type"
            label="Type"
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as PatternType }))}
            value={form.type}
          >
            {patternTypeOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Input
            id="scanner-edit-pattern"
            label="Pattern (regex source)"
            onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
            required
            value={form.pattern}
          />
          <Input
            hint="Leave blank for no flags. Common: i (case-insensitive), m (multiline)"
            id="scanner-edit-flags"
            label="Flags"
            maxLength={10}
            onChange={(e) => setForm((f) => ({ ...f, flags: e.target.value }))}
            value={form.flags}
          />
          {error && <Alert>{error}</Alert>}
          <ModalFooter
            isPending={update.isPending}
            onCancel={cancelEdit}
            pendingLabel="Saving…"
            submitLabel="Save changes"
          />
        </form>
      ) : (
        <div className="space-y-5">
          <EntityMetaBadges
            isActive={pattern.isActive}
            isBuiltIn={pattern.isBuiltIn}
            origin={pattern.origin}
          >
            <Badge tone="neutral">
              {patternTypeOptions.find((o) => o.value === pattern.type)?.label ?? pattern.type}
            </Badge>
          </EntityMetaBadges>

          <div>
            <div className="label-mono mb-1.5">Regex pattern</div>
            <pre className="overflow-x-auto rounded-sm border border-ink-600 bg-ink-900 p-3 font-mono text-sm text-paper-200 whitespace-pre-wrap break-all">
              /{pattern.pattern}/{pattern.flags}
            </pre>
          </div>

          <div className="flex items-center justify-between border-t border-ink-600 pt-4">
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
  const [toggleError, setToggleError] = useState<string | null>(null);

  async function toggleActive() {
    setToggleError(null);
    try {
      await update.mutateAsync({ id: pattern.id, isActive: !pattern.isActive });
    } catch (err) {
      setToggleError(errMsg(err, `Failed to update "${pattern.label}"`));
    }
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
            <Badge className="ml-1.5" tone="neutral">
              {pattern.origin}
            </Badge>
          )}
        </Td>
        <Td className="max-w-xs py-2 pr-4">
          <code className="block truncate font-mono text-[11px] text-paper-300">
            /{pattern.pattern}/{pattern.flags}
          </code>
        </Td>
        <Td className="py-2 pr-4">
          {pattern.isBuiltIn && (
            <Badge tone="muted" uppercase variant="text">
              built-in
            </Badge>
          )}
        </Td>
        <Td className="py-2 pr-4">
          <ToggleSwitch
            checked={pattern.isActive}
            disabled={update.isPending}
            onChange={toggleActive}
          />
          {toggleError && <Alert className="mt-2 text-xs">{toggleError}</Alert>}
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
      <CardHeader className={description ? 'mb-1' : undefined}>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      {description && <p className="mb-4 text-xs text-paper-400">{description}</p>}
      {patterns.length === 0 ? (
        <EmptyState className="py-4" title="No patterns in this category." />
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
    <div className="space-y-8">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            Create pattern
          </Button>
        }
        chapter="§ Govern"
        subtitle="Regex patterns used across four scanning stages: skill content injection/exfiltration detection, shell command blocking in the agent workspace, and advisory code security findings fed to the security reviewer. Built-in patterns can be toggled but not deleted."
        title="Scanner patterns"
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
              title="Injection patterns"
            />
            <PatternSection
              description="Checked when custom skill content is saved. Detects attempts to exfiltrate data via skill prompts."
              patterns={exfiltration}
              title="Exfiltration patterns"
            />
            <PatternSection
              description="Checked before each bash tool invocation. Dangerous matches are soft-blocked — the agent receives an error and can self-correct."
              patterns={shellCommand}
              title="Shell command patterns"
            />
            <PatternSection
              description="Checked against added lines in the final diff. Findings are advisory — passed to the security reviewer agent as structured context."
              patterns={codeSecurity}
              title="Code security patterns"
            />
            <PatternSection
              description="Checked against file paths before each writeFile tool call. Matches are hard-blocked — the agent cannot write to the matched path."
              patterns={sensitiveFile}
              title="Sensitive file patterns"
            />
          </>
        }
      </QueryBoundary>

      <CreatePatternModal onClose={() => setNewOpen(false)} open={newOpen} />
    </div>
  );
}
