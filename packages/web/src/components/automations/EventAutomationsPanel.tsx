'use client';

import { EVENT_SOURCE_KEYS, eventSource } from '@auto-swe/shared/automation';
import { useState } from 'react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { Icon } from '@/components/ui/Icon';
import { SkeletonRows } from '@/components/ui/LoadingState';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  type AutomationOwner,
  type EventAutomation,
  useAutomationTemplates,
  useDeleteEventAutomation,
  useEventAutomations,
  useUpdateEventAutomation,
} from '@/hooks/useAutomations';
import { errMsg } from '@/lib/errors';
import { AutomationHistory } from './AutomationHistory';
import { EventAutomationEditor } from './EventAutomationEditor';

function AutomationRow({
  owner,
  automation,
  canManage,
  onEdit,
  onRemove,
}: {
  owner: AutomationOwner;
  automation: EventAutomation;
  canManage: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const update = useUpdateEventAutomation(owner);
  const [showHistory, setShowHistory] = useState(false);
  const source = eventSource(automation.source);
  const parsed = source?.filters.safeParse(automation.filters);
  const items: ActionMenuItem[] = [
    {
      icon: 'list',
      id: 'history',
      label: showHistory ? 'Hide decisions' : 'Recent decisions',
      onAction: () => setShowHistory((v) => !v),
    },
    ...(canManage
      ? [
          { icon: 'edit' as const, id: 'edit', label: 'Edit', onAction: onEdit },
          {
            icon: 'trash' as const,
            id: 'remove',
            label: 'Remove',
            onAction: onRemove,
            tone: 'danger' as const,
          },
        ]
      : []),
  ];
  // Said only for the source's default template, whose options the source knows.
  const doing =
    automation.templateId === null ? source?.describeInputs?.(automation.inputs) : undefined;
  return (
    <li className="px-3.5 py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-paper-100">{automation.name}</div>
          <div className="mt-0.5 text-paper-500 text-xs">
            {source?.label ?? automation.source} ·{' '}
            {parsed?.success && source ? source.describe(parsed.data) : 'filters unreadable'}
          </div>
          <div className="mt-0.5 text-paper-500 text-xs">
            {doing && `${doing} · `}cooldown {automation.cooldownMinutes} min · at most{' '}
            {automation.maxRunsPerDay} a day
            {automation.template && ` · template ${automation.template.name}`}
            {automation.targetConnection &&
              ` · on ${automation.targetConnection.organizationName}/${automation.targetConnection.repoName}`}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ToggleSwitch
            ariaLabel={`${automation.enabled ? 'Disable' : 'Enable'} ${automation.name}`}
            checked={automation.enabled}
            disabled={!canManage || update.isPending}
            onChange={() => update.mutate({ enabled: !automation.enabled, id: automation.id })}
          />
          <ActionMenu items={items} label={`Actions for ${automation.name}`} />
        </div>
      </div>
      {update.isError && (
        <Alert className="mt-2">{errMsg(update.error, 'Could not change the automation.')}</Alert>
      )}
      {showHistory && (
        <div className="mt-3 rounded-md border border-ink-600 px-3 py-1">
          <AutomationHistory
            automationId={automation.id}
            canManage={canManage}
            source={automation.source}
          />
        </div>
      )}
    </li>
  );
}

/** The editor for one source, once that source's templates are loaded. */
function EditorFor({
  owner,
  sourceKey,
  automation,
  onDone,
}: {
  owner: AutomationOwner;
  sourceKey: string;
  automation?: EventAutomation;
  onDone: () => void;
}) {
  const templates = useAutomationTemplates(owner, sourceKey);
  if (templates.isLoading) {
    return <SkeletonRows label="automations" rows={3} />;
  }
  if (templates.isError) {
    return <Alert>{errMsg(templates.error, 'Could not load the templates.')}</Alert>;
  }
  return (
    <EventAutomationEditor
      automation={automation}
      onDone={onDone}
      owner={owner}
      sourceKey={sourceKey}
      templates={templates.data ?? []}
    />
  );
}

/**
 * An owner's event automations — a repository's, or a team's for sources whose automations
 * target a team: what each reacts to, what it starts, its on/off switch and what it decided.
 * Members read; the owning team's leads and admins manage — the server answers `canManage`.
 * Only sources whose automations belong to this kind of owner can be added.
 */
export function EventAutomationsPanel({ owner }: { owner: AutomationOwner }) {
  const { data, isLoading, isError, error } = useEventAutomations(owner);
  const remove = useDeleteEventAutomation(owner);
  const onRepository = 'connectionId' in owner;
  const sourceKeys = EVENT_SOURCE_KEYS.filter(
    (key) => eventSource(key)?.target === (onRepository ? 'repository' : 'team')
  );
  const where = onRepository ? 'this repository' : 'this team';
  const [pendingRemove, setPendingRemove] = useState<EventAutomation | null>(null);
  // null: list only; a source key: adding one; an automation: editing it.
  const [editing, setEditing] = useState<EventAutomation | { add: string } | null>(null);
  const canManage = data?.canManage ?? false;

  if (isLoading) {
    return <SkeletonRows label="automations" rows={3} />;
  }
  if (isError) {
    return <Alert>{errMsg(error, `Could not load ${where}’s automations.`)}</Alert>;
  }
  return (
    <div className="space-y-5">
      {remove.isError && <Alert>{errMsg(remove.error, 'Could not remove the automation.')}</Alert>}
      {data && data.automations.length > 0 ? (
        <ul className="divide-y divide-ink-600 rounded-lg border border-ink-500/70 bg-ink-900/40">
          {data.automations.map((a) => (
            <AutomationRow
              automation={a}
              canManage={canManage}
              key={a.id}
              onEdit={() => setEditing(a)}
              onRemove={() => setPendingRemove(a)}
              owner={owner}
            />
          ))}
        </ul>
      ) : (
        <p className="text-paper-500 text-sm">
          No event automations: nothing that happens {onRepository ? 'on' : 'for'} {where} starts a
          run.
        </p>
      )}
      {canManage &&
        (editing === null ? (
          <div className="flex flex-wrap gap-2">
            {sourceKeys.map((key) => (
              <Button key={key} onClick={() => setEditing({ add: key })} variant="secondary">
                <Icon name="plus" size={14} />
                {eventSource(key)?.label ?? key}
              </Button>
            ))}
          </div>
        ) : 'add' in editing ? (
          <EditorFor
            key={`add:${editing.add}`}
            onDone={() => setEditing(null)}
            owner={owner}
            sourceKey={editing.add}
          />
        ) : (
          <EditorFor
            automation={editing}
            key={editing.id}
            onDone={() => setEditing(null)}
            owner={owner}
            sourceKey={editing.source}
          />
        ))}
      {pendingRemove && (
        <ConfirmModal
          confirmLabel="Remove"
          dangerous
          message={`Remove "${pendingRemove.name}"? Its decisions stay in ${onRepository ? 'the repository’s' : 'the team’s'} history, which its limits keep reading.`}
          onClose={() => setPendingRemove(null)}
          onConfirm={() => remove.mutate(pendingRemove.id)}
          open
          title="Remove automation"
        />
      )}
    </div>
  );
}
