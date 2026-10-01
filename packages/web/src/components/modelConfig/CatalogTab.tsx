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
  useCreateCatalogEntry,
  useDeleteCatalogEntry,
  useDiscoverModels,
  useModelCatalog,
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
      <DiscoveryPanel cataloged={entries ?? []} onAdd={setCreating} />
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
        <QueryBoundary error={error} isError={isError} isLoading={isLoading} label="model catalog">
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

/// On demand: what each configured provider lists that nothing prices. Results
/// are suggestions — adding one is still an admin entering its price.
function DiscoveryPanel({
  cataloged,
  onAdd,
}: {
  cataloged: ModelCatalogEntry[];
  onAdd: (draft: NewEntryDraft) => void;
}) {
  const discover = useDiscoverModels();
  // Drop a model the moment it is added, without asking the providers again.
  const known = new Set(cataloged.map(entrySpec));
  return (
    <Card>
      <CardHeader>
        <CardTitle eyebrow="New from providers">Models the catalog lacks</CardTitle>
        <Button disabled={discover.isPending} onClick={() => discover.mutate()} size="sm">
          {discover.isPending ? 'Checking…' : 'Check providers for new models'}
        </Button>
      </CardHeader>
      <p className="mb-4 text-xs text-paper-500">
        Lists models through each global provider credential and shows the ones nothing prices.
        Nothing is added until you add it — with its price.
      </p>
      {discover.error && <Alert>{errMsg(discover.error, 'Could not check providers')}</Alert>}
      {discover.data?.length === 0 && (
        <p className="text-xs text-paper-500">No global provider credentials to check.</p>
      )}
      {discover.data?.map((p) => {
        const fresh = p.models.filter((m) => !known.has(m.spec));
        return (
          <div className="mb-4" key={p.provider}>
            <div className="mb-1 font-mono text-xs text-paper-300">{p.provider}</div>
            {!p.ok ? (
              <p className="text-xs text-brick-400">Could not list models: {p.error}</p>
            ) : fresh.length === 0 ? (
              <p className="text-xs text-paper-500">Nothing new — every listed model is priced.</p>
            ) : (
              <Table>
                <tbody>
                  {fresh.map((m) => (
                    <TRow key={m.spec}>
                      <Td className="py-1.5">
                        <div className="font-mono text-xs">{m.spec}</div>
                        {m.displayName && (
                          <div className="text-[11px] text-paper-500">{m.displayName}</div>
                        )}
                      </Td>
                      <Td className="py-1.5 text-xs">{m.kind.toLowerCase()}</Td>
                      <Td className="py-1.5 text-right">
                        <Button
                          onClick={() =>
                            onAdd({
                              displayName: m.displayName,
                              kind: m.kind,
                              modelId: m.modelId,
                              provider: p.provider,
                            })
                          }
                          size="sm"
                          variant="ghost"
                        >
                          Add
                        </Button>
                      </Td>
                    </TRow>
                  ))}
                </tbody>
              </Table>
            )}
          </div>
        );
      })}
    </Card>
  );
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
  const { error, saving, submit } = useIntegrationConfigForm();
  const create = useCreateCatalogEntry();
  const update = useUpdateCatalogEntry();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const body: CatalogEntryInput = {
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
          <div className="grid grid-cols-2 gap-4">
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
        <div className="grid grid-cols-2 gap-4">
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
        <div className="grid grid-cols-2 gap-4">
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
