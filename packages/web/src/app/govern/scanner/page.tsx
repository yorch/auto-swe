'use client';

import { useState } from 'react';
import { EntityMetaBadges } from '@/components/library/EntityMetaBadges';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { CopyButton } from '@/components/ui/CopyButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { SearchInput, Toolbar } from '@/components/ui/Toolbar';
import {
  type ScannerPattern,
  useCreateScannerPattern,
  useDeleteScannerPattern,
  useScannerPatterns,
  useUpdateScannerPattern,
} from '@/hooks/useAdmin';
import { errMsg } from '@/lib/errors';
import {
  SCANNER_PATTERN_TYPE_INFO,
  SCANNER_PATTERN_TYPE_ORDER,
  type ScannerPatternType,
} from '@/lib/scannerPatternTypes';
import { cn, FOCUS_RING, formatDate } from '@/lib/utils';

type PatternType = ScannerPatternType;

const patternTypeOptions: Array<{ label: string; value: PatternType }> =
  SCANNER_PATTERN_TYPE_ORDER.map((value) => ({
    label: SCANNER_PATTERN_TYPE_INFO[value].label,
    value,
  }));

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
          onChange={(v) => setForm((f) => ({ ...f, type: v as PatternType }))}
          options={patternTypeOptions}
          value={form.type}
        />
        <Input
          className="font-mono"
          hint="JavaScript regex source, without the surrounding slashes"
          id="scanner-new-pattern"
          label="Pattern (regex source)"
          onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
          placeholder="my\s+pattern"
          required
          value={form.pattern}
        />
        <Input
          className="font-mono"
          hint="Leave blank for no flags. Allowed: i (case-insensitive), m, s, u, v"
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

function formOf(pattern: ScannerPattern): PatternForm {
  return {
    flags: pattern.flags,
    label: pattern.label,
    pattern: pattern.pattern,
    type: pattern.type as PatternType,
  };
}

function PatternDetailModal({
  initialEditing = false,
  onClose,
  pattern,
}: {
  /** Open straight into the edit form (a custom pattern's "Edit" row action). */
  initialEditing?: boolean;
  onClose: () => void;
  pattern: ScannerPattern;
}) {
  const update = useUpdateScannerPattern();
  const canEdit = !pattern.isBuiltIn;
  const [editing, setEditing] = useState(initialEditing && canEdit);
  const [form, setForm] = useState<PatternForm>(() => formOf(pattern));
  const [error, setError] = useState<string | null>(null);

  const pat = pattern;

  function startEdit() {
    setForm(formOf(pat));
    setError(null);
    setEditing(true);
  }

  function cancelEdit() {
    // Opened straight into the form: cancelling closes, as there is no detail view behind it.
    if (initialEditing) {
      onClose();
      return;
    }
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
      open
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
            onChange={(v) => setForm((f) => ({ ...f, type: v as PatternType }))}
            options={patternTypeOptions}
            value={form.type}
          />
          <Input
            className="font-mono"
            id="scanner-edit-pattern"
            label="Pattern (regex source)"
            onChange={(e) => setForm((f) => ({ ...f, pattern: e.target.value }))}
            required
            value={form.pattern}
          />
          <Input
            className="font-mono"
            hint="Leave blank for no flags. Allowed: i (case-insensitive), m, s, u, v"
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
            <EnforcementBadge type={pattern.type} />
          </EntityMetaBadges>

          <p className="text-[13px] leading-relaxed text-paper-400">
            {SCANNER_PATTERN_TYPE_INFO[pattern.type].description}
          </p>

          <div>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-paper-400">Regex pattern</span>
              <CopyButton value={pattern.pattern} />
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-ink-500 bg-ink-900/70 p-3 font-mono text-[13px] leading-relaxed text-paper-100">
              <span className="text-paper-500">/</span>
              {pattern.pattern}
              <span className="text-paper-500">/</span>
              <span className="text-ember-300">{pattern.flags}</span>
            </pre>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-ink-600 pt-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-paper-500">Created</dt>
              <dd className="text-paper-300">{formatDate(pattern.createdAt)}</dd>
              <dt className="text-paper-500">Updated</dt>
              <dd className="text-paper-300">{formatDate(pattern.updatedAt)}</dd>
            </dl>
            {canEdit ? (
              <Button onClick={startEdit} variant="secondary">
                <Icon name="edit" size={14} />
                Edit
              </Button>
            ) : (
              <span className="text-xs text-paper-500">
                Built-in patterns can be toggled, not edited
              </span>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Enforcement ──────────────────────────────────────────────────────────────

/** What a match in each category does, so a row's weight is visible at a glance. */
const ENFORCEMENT: Record<PatternType, { label: string; tone: BadgeTone }> = {
  CODE_SECURITY: { label: 'Advisory', tone: 'dust' },
  EXFILTRATION: { label: 'Advisory', tone: 'dust' },
  INJECTION: { label: 'Advisory', tone: 'dust' },
  PII: { label: 'Eval scorer', tone: 'violet' },
  SENSITIVE_FILE: { label: 'Hard block', tone: 'brick' },
  SHELL_COMMAND: { label: 'Soft block', tone: 'amber' },
};

function EnforcementBadge({ type }: { type: PatternType }) {
  const { label, tone } = ENFORCEMENT[type];
  return (
    <Badge dot tone={tone} variant="outline">
      {label}
    </Badge>
  );
}

// ── Pattern Row ───────────────────────────────────────────────────────────────

interface RowActions {
  onView: (pattern: ScannerPattern) => void;
  onEdit: (pattern: ScannerPattern) => void;
  onDelete: (pattern: ScannerPattern) => void;
  onError: (message: string | null) => void;
}

function PatternRow({
  pattern,
  onView,
  onEdit,
  onDelete,
  onError,
}: { pattern: ScannerPattern } & RowActions) {
  const update = useUpdateScannerPattern();
  const [confirmDisable, setConfirmDisable] = useState(false);
  // Blocking rules stop agent actions outright, so switching one off needs a confirmation.
  const blocking = pattern.type === 'SHELL_COMMAND' || pattern.type === 'SENSITIVE_FILE';

  function requestToggle() {
    if (pattern.isActive && blocking) {
      setConfirmDisable(true);
      return;
    }
    toggleActive();
  }

  function toggleActive() {
    onError(null);
    update.mutate(
      { id: pattern.id, isActive: !pattern.isActive },
      {
        onError: (err) =>
          onError(
            errMsg(err, `Could not ${pattern.isActive ? 'disable' : 'enable'} "${pattern.label}"`)
          ),
      }
    );
  }

  const regex = `/${pattern.pattern}/${pattern.flags}`;

  return (
    <TRow hover>
      <Td className="py-3 pr-4 sm:max-w-0 sm:w-full" primary>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <button
            className={cn(
              'truncate rounded-sm text-left font-medium hover:text-ember-300 hover:underline',
              pattern.isActive ? 'text-paper-100' : 'text-paper-400',
              FOCUS_RING
            )}
            onClick={() => onView(pattern)}
            type="button"
          >
            {pattern.label}
          </button>
          {!pattern.isActive && (
            <Badge tone="muted" variant="outline">
              Off
            </Badge>
          )}
        </div>
        <code
          className="mt-1 block truncate font-mono text-xs font-normal text-paper-400"
          title={regex}
        >
          {regex}
        </code>
      </Td>
      <Td className="px-4 py-3" label="Source">
        <div className="flex flex-wrap items-center gap-1">
          {pattern.isBuiltIn ? (
            <Badge tone="neutral" variant="outline">
              Built-in
            </Badge>
          ) : (
            <Badge tone="ember" variant="outline">
              Custom
            </Badge>
          )}
          {pattern.origin && (
            <Badge title={`Installed by the ${pattern.origin} bundle`} tone="neutral">
              {pattern.origin}
            </Badge>
          )}
        </div>
      </Td>
      <Td className="px-4 py-3" label="Active">
        <ToggleSwitch
          ariaLabel={`Active: ${pattern.label}`}
          checked={pattern.isActive}
          disabled={update.isPending}
          onChange={requestToggle}
          title={`${pattern.isActive ? 'Disable' : 'Enable'} ${pattern.label}`}
        />
        {confirmDisable && (
          <ConfirmModal
            confirmLabel="Disable rule"
            dangerous
            message={
              pattern.type === 'SENSITIVE_FILE'
                ? 'Agents will be able to write to files this rule protects, with no block from the sensitive file scanner, until you enable it again.'
                : 'Agents will be able to run shell commands this rule blocks, with no warning from the shell scanner, until you enable it again.'
            }
            onClose={() => setConfirmDisable(false)}
            onConfirm={() => toggleActive()}
            open
            title={`Disable "${pattern.label}"?`}
          />
        )}
      </Td>
      <Td align="right" className="py-3 pl-4">
        <ActionMenu
          items={[
            { icon: 'info', id: 'view', label: 'View details', onAction: () => onView(pattern) },
            ...(pattern.isBuiltIn
              ? []
              : [
                  {
                    icon: 'edit' as const,
                    id: 'edit',
                    label: 'Edit',
                    onAction: () => onEdit(pattern),
                  },
                  {
                    icon: 'trash' as const,
                    id: 'delete',
                    label: 'Delete',
                    onAction: () => onDelete(pattern),
                    tone: 'danger' as const,
                  },
                ]),
          ]}
          label={`Actions for ${pattern.label}`}
        />
      </Td>
    </TRow>
  );
}

// ── Pattern Section ───────────────────────────────────────────────────────────

function PatternSection({
  actions,
  filtered,
  patterns,
  total,
  type,
}: {
  actions: RowActions;
  /** True while a search or status filter narrows the list. */
  filtered: boolean;
  patterns: ScannerPattern[];
  /** Patterns in the category before filtering. */
  total: number;
  type: PatternType;
}) {
  const info = SCANNER_PATTERN_TYPE_INFO[type];
  const activeCount = patterns.filter((p) => p.isActive).length;
  return (
    <Card className="scroll-mt-4 p-4 sm:p-6" id={`scanner-${type}`}>
      <CardHeader className="mb-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-[17px] font-semibold tracking-tight text-paper-50">{info.title}</h2>
          <EnforcementBadge type={type} />
        </div>
        <span className="text-xs text-paper-500 tabular-nums">
          {filtered ? `${patterns.length} of ${total}` : `${activeCount} of ${total} active`}
        </span>
      </CardHeader>
      <p className="mb-4 max-w-3xl text-[13px] leading-relaxed text-paper-400">
        {info.description}
      </p>
      {patterns.length === 0 ? (
        <EmptyState
          className="py-6"
          hint={filtered ? undefined : 'Create a pattern of this type to start checking for it.'}
          icon={null}
          title={filtered ? 'No patterns in this category match' : 'No patterns in this category'}
        />
      ) : (
        <Table stacked>
          <THead>
            <Th className="pl-0" variant="plain">
              Rule
            </Th>
            <Th variant="plain">Source</Th>
            <Th variant="plain">Active</Th>
            <Th className="pr-0" variant="plain">
              <span className="sr-only">Actions</span>
            </Th>
          </THead>
          <tbody>
            {patterns.map((p) => (
              <PatternRow key={p.id} pattern={p} {...actions} />
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

type StatusFilter = '' | 'active' | 'inactive';

export default function GovernScannerPage() {
  const [newOpen, setNewOpen] = useState(false);
  const {
    data: patterns,
    isLoading,
    isError,
    isFetching,
    refetch,
    error: loadError,
  } = useScannerPatterns();
  // One detail modal and one delete confirmation for the page, bound to the
  // selected row — not one of each mounted per row.
  const [viewTarget, setViewTarget] = useState<{
    editing: boolean;
    pattern: ScannerPattern;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScannerPattern | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'' | PatternType>('');
  const [status, setStatus] = useState<StatusFilter>('');
  const deletePattern = useDeleteScannerPattern();
  const rowActions: RowActions = {
    onDelete: setDeleteTarget,
    onEdit: (pattern) => setViewTarget({ editing: true, pattern }),
    onError: setActionError,
    onView: (pattern) => setViewTarget({ editing: false, pattern }),
  };

  const all = patterns ?? [];
  const query = search.trim().toLowerCase();
  const matches = (p: ScannerPattern) =>
    (!status || (status === 'active' ? p.isActive : !p.isActive)) &&
    (!query ||
      p.label.toLowerCase().includes(query) ||
      p.pattern.toLowerCase().includes(query) ||
      (p.origin ?? '').toLowerCase().includes(query));
  const filtering = query !== '' || status !== '';
  const types = category ? [category] : SCANNER_PATTERN_TYPE_ORDER;
  const sections = types
    .map((type) => {
      const inType = all.filter((p) => p.type === type);
      return { patterns: inType.filter(matches), total: inType.length, type };
    })
    // While filtering, a category with no match drops out instead of showing an empty card.
    .filter((sec) => !filtering || category !== '' || sec.patterns.length > 0);
  const shown = sections.reduce((n, sec) => n + sec.patterns.length, 0);
  const activeTotal = all.filter((p) => p.isActive).length;
  const countOf = (type: PatternType) => all.filter((p) => p.type === type).length;
  const clearFilters = () => {
    setSearch('');
    setStatus('');
    setCategory('');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        actions={
          <Button onClick={() => setNewOpen(true)} variant="primary">
            <Icon name="plus" size={14} />
            New pattern
          </Button>
        }
        subtitle="Regex patterns behind the runtime scanners: skill-content and LLM-output injection/exfiltration checks, shell command and sensitive-file blocking, advisory code security findings, and the PII eval scorer. Built-in patterns can be toggled but not deleted."
        title="Scanner patterns"
      />

      <QueryBoundary
        error={loadError}
        isError={isError}
        isFetching={isFetching}
        isLoading={false}
        label="scanner patterns"
        onRetry={() => void refetch()}
      >
        {isLoading ? (
          <Card>
            <SkeletonRows rows={8} />
          </Card>
        ) : (
          <>
            <Toolbar
              className="mb-0"
              end={
                <span className="text-xs text-paper-500 tabular-nums">
                  {filtering || category
                    ? `${shown} of ${all.length} patterns`
                    : `${activeTotal} of ${all.length} active`}
                </span>
              }
            >
              <SearchInput
                label="Search patterns"
                onChange={setSearch}
                placeholder="Search label or regex…"
                value={search}
              />
              <Select
                aria-label="Filter by category"
                className="h-8 w-full text-[13px] sm:w-60"
                onChange={(v) => setCategory(v as '' | PatternType)}
                options={[
                  { label: 'All categories', value: '' },
                  ...SCANNER_PATTERN_TYPE_ORDER.map((type) => ({
                    label: `${SCANNER_PATTERN_TYPE_INFO[type].title} (${countOf(type)})`,
                    value: type,
                  })),
                ]}
                value={category}
              />
              <SegmentedControl<StatusFilter>
                ariaLabel="Filter by state"
                onChange={setStatus}
                options={[
                  { label: 'All', value: '' },
                  { label: 'Active', value: 'active' },
                  { label: 'Off', value: 'inactive' },
                ]}
                value={status}
              />
              {(filtering || category) && (
                <Button onClick={clearFilters} size="sm" variant="ghost">
                  Clear filters
                </Button>
              )}
            </Toolbar>
            {actionError && <Alert variant="error">{actionError}</Alert>}
            {all.length === 0 ? (
              <EmptyState
                action={
                  <Button onClick={() => setNewOpen(true)} size="sm" variant="primary">
                    New pattern
                  </Button>
                }
                bordered
                hint="Built-in patterns sync when the gateway starts. Restart it, or create a custom pattern."
                icon="scan"
                title="No scanner patterns"
              />
            ) : sections.length === 0 ? (
              <EmptyState
                action={
                  <Button onClick={clearFilters} size="sm">
                    Clear filters
                  </Button>
                }
                bordered
                hint="Try a different search or state."
                icon="search"
                title="No patterns match these filters"
              />
            ) : (
              sections.map((sec) => (
                <PatternSection
                  actions={rowActions}
                  filtered={filtering}
                  key={sec.type}
                  patterns={sec.patterns}
                  total={sec.total}
                  type={sec.type}
                />
              ))
            )}
          </>
        )}
      </QueryBoundary>

      <CreatePatternModal onClose={() => setNewOpen(false)} open={newOpen} />
      {viewTarget && (
        // Keyed so the modal's edit state starts fresh for each pattern opened.
        <PatternDetailModal
          initialEditing={viewTarget.editing}
          key={`${viewTarget.pattern.id}-${viewTarget.editing}`}
          onClose={() => setViewTarget(null)}
          pattern={viewTarget.pattern}
        />
      )}
      {deleteTarget && (
        <ConfirmModal
          confirmLabel="Delete"
          dangerous
          message="This will permanently remove the scanner pattern. This cannot be undone."
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            await deletePattern.mutateAsync(deleteTarget.id);
          }}
          open
          pendingLabel="Deleting…"
          title={`Delete "${deleteTarget.label}"?`}
        />
      )}
    </div>
  );
}
