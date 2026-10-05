'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader, CardTitle } from '@/components/ui/Card';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal, ModalFooter } from '@/components/ui/Modal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import { Table, TableStatusRow, Td, THead, Th, TRow } from '@/components/ui/Table';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useIntegrationConfigForm } from '@/hooks/useIntegrationConfigForm';
import {
  type CatalogEntryInput,
  type ModelSuggestion,
  useCreateCatalogEntry,
  useDeleteCatalogEntry,
  useDiscoverModels,
  useDismissSuggestion,
  useModelCatalog,
  useModelSuggestions,
  useResetCatalogEntry,
  useUnpricedModels,
  useUpdateCatalogEntry,
} from '@/hooks/useModelCatalog';
import { errMsg } from '@/lib/errors';
import {
  divergesFromBuiltin,
  entrySpec,
  formatPrice,
  type ModelCatalogEntry,
  type ModelKind,
  type ModelStatus,
} from '@/lib/modelCatalog';
import { formatDate } from '@/lib/utils';

/** What an "Add model" starts from: blank, an unpriced spec, or a discovered model. */
interface NewEntryDraft {
  provider: string;
  modelId: string;
  kind?: ModelKind;
  displayName?: string | null;
}

const STATUS_TONE = { ACTIVE: 'moss', DEPRECATED: 'amber', RETIRED: 'muted' } as const;

/// The model catalog: the per-MTok prices every LLM and embedding call is
/// costed at. A model with no entry is recorded at $0, which USD budgets never
/// see — the unpriced panel lists the ones in use.
export function CatalogTab() {
  const [showRetired, setShowRetired] = useState(false);
  const {
    data: entries,
    error,
    isError,
    isFetching,
    refetch,
    isLoading,
  } = useModelCatalog({
    includeRetired: showRetired,
  });
  const [editing, setEditing] = useState<ModelCatalogEntry | null>(null);
  const [creating, setCreating] = useState<NewEntryDraft | null>(null);
  const [deleting, setDeleting] = useState<ModelCatalogEntry | null>(null);
  const reset = useResetCatalogEntry();
  const del = useDeleteCatalogEntry();

  return (
    <div className="space-y-6">
      <UnpricedPanel onAdd={(spec) => setCreating(splitSpec(spec))} />
      <DiscoveryPanel cataloged={entries ?? []} onAdd={setCreating} onEdit={setEditing} />
      <Card>
        <CardHeader>
          <CardTitle eyebrow="Model catalog">Prices per million tokens</CardTitle>
          <div className="flex items-center gap-4">
            <ToggleSwitch
              checked={showRetired}
              label="Show retired"
              onChange={() => setShowRetired((v) => !v)}
            />
            <Button onClick={() => setCreating({ modelId: '', provider: '' })} size="sm">
              Add model
            </Button>
          </div>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Built-in models follow the prices code ships until edited; an edit marks the row
          customized and keeps it. Edits reach the worker within the config cache window, and never
          reprice calls already recorded.
        </p>
        <QueryBoundary
          error={error}
          isError={isError}
          isFetching={isFetching}
          isLoading={isLoading}
          label="model catalog"
          onRetry={() => void refetch()}
        >
          <Table>
            <THead>
              <Th variant="compact">Model</Th>
              <Th variant="compact">Kind</Th>
              <Th variant="compact">Price</Th>
              <Th variant="compact">Status</Th>
              <Th variant="compact">Source</Th>
              <Th align="right" variant="compact">
                Actions
              </Th>
            </THead>
            <tbody>
              {(entries ?? []).map((e) => (
                <TRow key={e.id}>
                  <Td className="py-2">
                    <div className="font-mono text-xs">{entrySpec(e)}</div>
                    {e.displayName && (
                      <div className="text-[11px] text-paper-500">{e.displayName}</div>
                    )}
                    {e.notes && <div className="text-[11px] text-paper-500">{e.notes}</div>}
                  </Td>
                  <Td className="py-2 text-xs">{e.kind.toLowerCase()}</Td>
                  <Td className="py-2 font-mono text-xs">
                    {formatPrice(e)}
                    {divergesFromBuiltin(e) && e.builtin && (
                      <div className="text-[11px] text-amber-400">
                        built-in is now {formatPrice({ ...e.builtin })}
                        {e.builtin.status !== e.status && `, ${e.builtin.status.toLowerCase()}`}
                      </div>
                    )}
                  </Td>
                  <Td className="py-2">
                    <Badge tone={STATUS_TONE[e.status]} variant="text">
                      {e.status.toLowerCase()}
                    </Badge>
                  </Td>
                  <Td className="py-2">
                    <SourceBadge entry={e} />
                  </Td>
                  <Td className="py-2 text-right">
                    <Button onClick={() => setEditing(e)} size="sm" variant="ghost">
                      Edit
                    </Button>
                    {e.isBuiltIn && e.isCustomized && (
                      <Button
                        disabled={reset.isPending}
                        onClick={() => reset.mutate(e.id)}
                        size="sm"
                        variant="ghost"
                      >
                        Reset
                      </Button>
                    )}
                    {!e.isBuiltIn && (
                      <Button onClick={() => setDeleting(e)} size="sm" variant="danger">
                        Delete
                      </Button>
                    )}
                  </Td>
                </TRow>
              ))}
              {(entries ?? []).length === 0 && (
                <TableStatusRow colSpan={6}>
                  <EmptyState
                    hint="The gateway seeds the built-in models at startup."
                    title="The catalog is empty"
                  />
                </TableStatusRow>
              )}
            </tbody>
          </Table>
        </QueryBoundary>
      </Card>

      {(creating || editing) && (
        <EntryModal
          existing={editing}
          initial={creating}
          onClose={() => {
            setCreating(null);
            setEditing(null);
          }}
        />
      )}
      <ConfirmModal
        confirmLabel="Delete"
        dangerous
        message={`Delete ${deleting ? entrySpec(deleting) : ''}? Calls to it will be recorded at $0 again.`}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) {
            await del.mutateAsync(deleting.id);
          }
        }}
        open={deleting !== null}
        title="Delete model"
      />
    </div>
  );
}

function splitSpec(spec: string): { provider: string; modelId: string } {
  const slash = spec.indexOf('/');
  return slash === -1
    ? { modelId: spec, provider: '' }
    : { modelId: spec.slice(slash + 1), provider: spec.slice(0, slash).toLowerCase() };
}

function SourceBadge({ entry }: { entry: ModelCatalogEntry }) {
  if (!entry.isBuiltIn) {
    return (
      <Badge tone="violet" variant="text">
        custom
      </Badge>
    );
  }
  return entry.isCustomized ? (
    <Badge tone="amber" variant="text">
      customized
    </Badge>
  ) : (
    <Badge tone="neutral" variant="text">
      built-in
    </Badge>
  );
}

function UnpricedPanel({ onAdd }: { onAdd: (spec: string) => void }) {
  const { data } = useUnpricedModels();
  if (!data || data.length === 0) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="Unpriced in use">Recorded at $0</CardTitle>
      </CardHeader>
      <p className="mb-4 text-xs text-paper-500">
        These models are configured or were called in the last 30 days, but nothing prices them —
        their spend never reaches a USD budget. Add each one, or fix a misspelled spec.
      </p>
      <Table>
        <THead>
          <Th variant="compact">Spec</Th>
          <Th variant="compact">Used by</Th>
          <Th variant="compact">Did you mean</Th>
          <Th align="right" variant="compact">
            Actions
          </Th>
        </THead>
        <tbody>
          {data.map((u) => (
            <TRow key={u.spec}>
              <Td className="py-2 font-mono text-xs">{u.spec}</Td>
              <Td className="py-2 text-xs">{u.usedBy.join(', ')}</Td>
              <Td className="py-2 font-mono text-xs">{u.suggestion ?? '—'}</Td>
              <Td className="py-2 text-right">
                <Button onClick={() => onAdd(u.spec)} size="sm" variant="ghost">
                  Add to catalog
                </Button>
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

/// What the discovery run stored: models a provider lists that nothing prices,
/// and priced ones it no longer lists. The run is scheduled; "Check providers
/// now" runs it on demand. Both are suggestions — adding one is still an admin
/// entering its price, and nothing here retires a model.
function DiscoveryPanel({
  cataloged,
  onAdd,
  onEdit,
}: {
  cataloged: ModelCatalogEntry[];
  onAdd: (draft: NewEntryDraft) => void;
  onEdit: (entry: ModelCatalogEntry) => void;
}) {
  const [showDismissed, setShowDismissed] = useState(false);
  const { data, error } = useModelSuggestions(showDismissed);
  const discover = useDiscoverModels();
  const dismiss = useDismissSuggestion();
  // Drop a model the moment it is added, without waiting for the next run.
  const bySpec = new Map(cataloged.map((e) => [entrySpec(e), e]));
  const fresh = (data?.suggestions ?? []).filter((s) => s.type === 'NEW' && !bySpec.has(s.spec));
  const retired = (data?.suggestions ?? []).filter(
    (s) => s.type === 'RETIREMENT_CANDIDATE' && bySpec.has(s.spec)
  );
  const failed = (data?.providers ?? []).filter((p) => p.error);
  const lastChecked = (data?.providers ?? []).reduce<string | null>(
    (latest, p) => (latest && latest > p.checkedAt ? latest : p.checkedAt),
    null
  );

  // Why the list is empty, because "nothing new" is only one of four reasons.
  const providers = data?.providers ?? [];
  const hiddenNew = data?.hiddenDismissed.NEW ?? 0;
  const emptyMessage =
    providers.length === 0
      ? 'No provider has been checked. Providers are listed through a global credential: add one, then run Check providers now.'
      : providers.every((p) => p.error)
        ? 'No provider could be listed, so nothing is known about new models. See the errors above.'
        : hiddenNew > 0
          ? `Nothing to show: ${hiddenNew} suggestion${hiddenNew === 1 ? ' is' : 's are'} dismissed. Turn on Show dismissed to see them.`
          : failed.length > 0
            ? 'Nothing new from the providers that could be listed.'
            : 'Nothing new — every listed model is priced.';

  const dismissButton = (s: ModelSuggestion) => (
    <Button
      disabled={dismiss.isPending}
      onClick={() => dismiss.mutate({ dismiss: s.dismissedAt === null, id: s.id })}
      size="sm"
      variant="ghost"
    >
      {s.dismissedAt === null ? 'Dismiss' : 'Restore'}
    </Button>
  );

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle eyebrow="New from providers">Models the catalog lacks</CardTitle>
          <div className="flex items-center gap-4">
            <ToggleSwitch
              checked={showDismissed}
              label="Show dismissed"
              onChange={() => setShowDismissed((v) => !v)}
            />
            <Button disabled={discover.isPending} onClick={() => discover.mutate()} size="sm">
              {discover.isPending ? 'Checking…' : 'Check providers now'}
            </Button>
          </div>
        </CardHeader>
        <p className="mb-4 text-xs text-paper-500">
          Providers are asked on a schedule, through each global provider credential. Nothing is
          added to the catalog until you add it — with its price.{' '}
          {lastChecked
            ? `Last checked ${formatDate(lastChecked)}.`
            : 'No provider has been checked yet.'}
        </p>
        {error && <Alert>{errMsg(error, 'Could not load suggestions')}</Alert>}
        {discover.error && <Alert>{errMsg(discover.error, 'Could not check providers')}</Alert>}
        {failed.map((p) => (
          <p className="mb-2 text-xs text-brick-400" key={p.provider}>
            {p.provider}: could not list models ({p.error}) at {formatDate(p.checkedAt)}.{' '}
            {p.lastSuccessAt
              ? `Its last complete listing was ${formatDate(p.lastSuccessAt)}.`
              : 'It has never been listed completely.'}
          </p>
        ))}
        {data && fresh.length === 0 ? (
          <p className="text-xs text-paper-500">{emptyMessage}</p>
        ) : (
          <Table>
            <tbody>
              {fresh.map((m) => (
                <TRow key={m.id}>
                  <Td className="py-1.5">
                    <div className={`font-mono text-xs ${m.dismissedAt ? 'text-paper-500' : ''}`}>
                      {m.spec}
                    </div>
                    {m.displayName && (
                      <div className="text-[11px] text-paper-500">{m.displayName}</div>
                    )}
                  </Td>
                  <Td className="py-1.5 text-xs">{m.kind.toLowerCase()}</Td>
                  <Td className="py-1.5 text-xs text-paper-500">
                    first seen {formatDate(m.firstSeenAt)}
                  </Td>
                  <Td className="py-1.5 text-right">
                    <Button
                      onClick={() =>
                        onAdd({
                          displayName: m.displayName,
                          kind: m.kind,
                          modelId: m.modelId,
                          provider: m.provider,
                        })
                      }
                      size="sm"
                      variant="ghost"
                    >
                      Add
                    </Button>
                    {dismissButton(m)}
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {retired.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle eyebrow="Possibly retired">Priced, but no longer listed</CardTitle>
          </CardHeader>
          <p className="mb-4 text-xs text-paper-500">
            A provider whose listing succeeded no longer lists these. Nothing is retired for you: a
            pinned agent version may still bill against one, and a provider may serve an alias it
            does not list. Edit the row to mark it deprecated or retired, or dismiss the flag.
          </p>
          <Table>
            <tbody>
              {retired.map((m) => (
                <TRow key={m.id}>
                  <Td className="py-1.5 font-mono text-xs">{m.spec}</Td>
                  <Td className="py-1.5 text-xs text-paper-500">
                    not listed since {formatDate(m.firstSeenAt)}
                  </Td>
                  <Td className="py-1.5 text-right">
                    <Button
                      onClick={() => {
                        const entry = bySpec.get(m.spec);
                        if (entry) {
                          onEdit(entry);
                        }
                      }}
                      size="sm"
                      variant="ghost"
                    >
                      Edit
                    </Button>
                    {dismissButton(m)}
                  </Td>
                </TRow>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

/** Multiples of the input price; blank uses the built-in rate, shown when the row has one. */
function cacheHint(builtinRate: number | undefined): string {
  return builtinRate === undefined ? 'Blank: built-in rate' : `Blank: ${builtinRate}×`;
}

function EntryModal({
  existing,
  initial,
  onClose,
}: {
  existing: ModelCatalogEntry | null;
  initial: NewEntryDraft | null;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState(initial?.provider ?? '');
  const [modelId, setModelId] = useState(initial?.modelId ?? '');
  const [kind, setKind] = useState<ModelKind>(existing?.kind ?? initial?.kind ?? 'CHAT');
  const [status, setStatus] = useState<ModelStatus>(existing?.status ?? 'ACTIVE');
  const [input, setInput] = useState(String(existing?.inputUsdPerMTok ?? ''));
  const [output, setOutput] = useState(String(existing?.outputUsdPerMTok ?? ''));
  const [displayName, setDisplayName] = useState(
    existing?.displayName ?? initial?.displayName ?? ''
  );
  const [notes, setNotes] = useState(existing?.notes ?? '');
  const [cacheRead, setCacheRead] = useState(String(existing?.cacheReadMultiplier ?? ''));
  const [cacheWrite5m, setCacheWrite5m] = useState(String(existing?.cacheWrite5mMultiplier ?? ''));
  const [cacheWrite1h, setCacheWrite1h] = useState(String(existing?.cacheWrite1hMultiplier ?? ''));
  const { error, saving, submit } = useIntegrationConfigForm();
  const create = useCreateCatalogEntry();
  const update = useUpdateCatalogEntry();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Blank clears the override, so the built-in rate for the provider applies.
    const multiplier = (v: string) => (v.trim() === '' ? null : Number(v));
    const body: CatalogEntryInput = {
      cacheReadMultiplier: multiplier(cacheRead),
      cacheWrite1hMultiplier: multiplier(cacheWrite1h),
      cacheWrite5mMultiplier: multiplier(cacheWrite5m),
      displayName: displayName.trim() || null,
      inputUsdPerMTok: Number(input),
      kind,
      notes: notes.trim() || null,
      outputUsdPerMTok: Number(output),
      status,
    };
    void submit(async () => {
      if (existing) {
        await update.mutateAsync({ id: existing.id, ...body });
      } else {
        await create.mutateAsync({ ...body, modelId: modelId.trim(), provider: provider.trim() });
      }
      onClose();
    });
  };

  return (
    <Modal
      onClose={onClose}
      open
      subtitle={
        existing?.isBuiltIn && !existing.isCustomized
          ? 'Saving marks this built-in model customized: startup will keep your values until you reset it.'
          : undefined
      }
      title={existing ? `Edit ${entrySpec(existing)}` : 'Add model'}
    >
      <form className="space-y-4" onSubmit={handleSubmit}>
        {!existing && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              className="font-mono text-xs"
              id="catalogProvider"
              label="Provider"
              onChange={(e) => setProvider(e.target.value)}
              placeholder="openai / ollama / openrouter"
              required
              value={provider}
            />
            <Input
              className="font-mono text-xs"
              id="catalogModelId"
              label="Model id"
              onChange={(e) => setModelId(e.target.value)}
              placeholder="gpt-5.5"
              required
              value={modelId}
            />
          </div>
        )}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            hint="USD per million tokens. 0 and 0 marks a free model."
            id="catalogInput"
            label="Input price"
            min={0}
            onChange={(e) => setInput(e.target.value)}
            required
            step="any"
            type="number"
            value={input}
          />
          <Input
            hint={kind === 'EMBEDDING' ? 'Embedding models bill input only — use 0.' : undefined}
            id="catalogOutput"
            label="Output price"
            min={0}
            onChange={(e) => setOutput(e.target.value)}
            required
            step="any"
            type="number"
            value={output}
          />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <Input
            hint={cacheHint(existing?.cacheDefaults?.cacheReadMultiplier)}
            id="catalogCacheRead"
            label="Cache read ×"
            min={0}
            onChange={(e) => setCacheRead(e.target.value)}
            step="any"
            type="number"
            value={cacheRead}
          />
          <Input
            hint={cacheHint(existing?.cacheDefaults?.cacheWrite5mMultiplier)}
            id="catalogCacheWrite5m"
            label="Cache write (5 min) ×"
            min={0}
            onChange={(e) => setCacheWrite5m(e.target.value)}
            step="any"
            type="number"
            value={cacheWrite5m}
          />
          <Input
            hint={cacheHint(existing?.cacheDefaults?.cacheWrite1hMultiplier)}
            id="catalogCacheWrite1h"
            label="Cache write (1 h) ×"
            min={0}
            onChange={(e) => setCacheWrite1h(e.target.value)}
            step="any"
            type="number"
            value={cacheWrite1h}
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            id="catalogKind"
            label="Kind"
            onChange={(v) => setKind(v as ModelKind)}
            options={[
              { label: 'Chat', value: 'CHAT' },
              { label: 'Embedding', value: 'EMBEDDING' },
            ]}
            value={kind}
          />
          <Select
            hint="Retired models leave the pickers but stay priced for pinned agents."
            id="catalogStatus"
            label="Status"
            onChange={(v) => setStatus(v as ModelStatus)}
            options={[
              { label: 'Active', value: 'ACTIVE' },
              { label: 'Deprecated', value: 'DEPRECATED' },
              { label: 'Retired', value: 'RETIRED' },
            ]}
            value={status}
          />
        </div>
        <Input
          id="catalogDisplayName"
          label="Display name (optional)"
          onChange={(e) => setDisplayName(e.target.value)}
          value={displayName}
        />
        <Input
          hint="Pricing caveats, such as an introductory rate or a long-context surcharge."
          id="catalogNotes"
          label="Notes (optional)"
          onChange={(e) => setNotes(e.target.value)}
          value={notes}
        />
        {error && <Alert>{error}</Alert>}
        <ModalFooter
          isPending={saving}
          onCancel={onClose}
          pendingLabel="Saving…"
          submitLabel={existing ? 'Save changes' : 'Add model'}
        />
      </form>
    </Modal>
  );
}
