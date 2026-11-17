'use client';

import { DEFAULT_BRIEF_INPUT_SCHEMA, isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import { workflowPresentation } from '@auto-swe/shared/lib/workflowCatalog';
import {
  getWorkspaceProviderMetadata,
  isWorkspaceProviderType,
} from '@auto-swe/shared/lib/workspaceProviders';
import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { KnowledgeBasePicker } from '@/components/knowledgeBases/KnowledgeBasePicker';
import { LaunchCardHeader, ReviewList } from '@/components/requests/LaunchSteps';
import { SampleTaskButton } from '@/components/requests/SampleTaskButton';
import { WorkflowLaunchSummary } from '@/components/requests/WorkflowLaunchSummary';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import {
  buildInitialPayload,
  ConnectionPicker,
  SchemaFieldInput,
  validatePayload,
} from '@/components/workflow/schemaForm';
import {
  type KnowledgeBaseRunOverrides,
  knowledgeBaseOverrideBody,
} from '@/hooks/useKnowledgeBases';
import { useRepositories } from '@/hooks/useRepositories';
import { useRunTemplate } from '@/hooks/useTemplates';
import { type TicketPreview, useTicketPreview } from '@/hooks/useTicketPreview';
import {
  describeLaunchError,
  egressPolicyFor,
  NETWORK_ACCESS_HINT,
  NETWORK_ACCESS_OPTIONS,
  type NetworkAccess,
  parseNetworkAccess,
} from '@/lib/agentRun';
import { ApiError } from '@/lib/api';
import { connectionLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';
import { pickSampleField, WORKFLOW_SAMPLE } from '@/lib/sampleTasks';
import {
  applyTicketErrors,
  DESCRIPTION_HINT_WITH_TICKET,
  submitPayload,
  TASK_NAME_HINT,
  TRACKER_UNREACHABLE,
  ticketFieldState,
} from '@/lib/ticketField';
import { humanizeWorkflowKey, workflowFieldLabel } from '@/lib/workflowLabels';

function hasText(value: unknown) {
  return typeof value === 'string' && value.trim() !== '';
}

/** The "Fetch title" action and its result. The title comes from the tracker: plain text only. */
function TicketTitleLookup({
  canFetch,
  isPending,
  errorMessage,
  onFetch,
  onUseAsName,
  result,
}: {
  canFetch: boolean;
  isPending: boolean;
  /** Set when the lookup for the current ticket and repository failed. */
  errorMessage: string | null;
  onFetch: () => void;
  onUseAsName: (title: string) => void;
  result: TicketPreview | null;
}) {
  const title = result?.title?.trim() ? result.title.trim() : null;
  return (
    <div className="space-y-1.5 text-xs">
      <Button
        disabled={!canFetch || isPending}
        onClick={onFetch}
        size="sm"
        type="button"
        variant="secondary"
      >
        {isPending ? 'Fetching…' : 'Fetch title'}
      </Button>
      <div aria-live="polite" className="space-y-1.5">
        {errorMessage && !result && <p className="text-warning-400">{errorMessage}</p>}
        {result?.configured === false && (
          <p className="text-paper-500">
            No issue tracker is configured, so this ID is only a label for the branch and run.
          </p>
        )}
        {result?.configured && !result.found && (
          <p className="text-warning-400">
            That ticket couldn't be read (not found, or outside this repository's scope).
          </p>
        )}
        {result?.configured && result.found && title && (
          <div className="flex flex-wrap items-center gap-3 text-paper-300">
            <span>
              {title}
              {result.status ? ` · ${result.status}` : ''}
            </span>
            <Button onClick={() => onUseAsName(title)} size="sm" type="button" variant="ghost">
              Use as task name
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkflowLaunchForm({
  template,
  onLaunched,
  showProcessSummary = true,
}: {
  template: WorkflowTemplateSummary;
  onLaunched: (requestId: string) => void;
  showProcessSummary?: boolean;
}) {
  const taskNameId = useId();
  const schema = isInputSchema(template.inputSchema)
    ? template.inputSchema
    : template.inputSchema == null &&
        (template.workspaceProvider == null || template.workspaceProvider === 'git_repo')
      ? DEFAULT_BRIEF_INPUT_SCHEMA
      : null;
  const [payload, setPayload] = useState<Record<string, unknown>>(
    schema ? buildInitialPayload(schema) : {}
  );
  const [label, setLabel] = useState('');
  const [networkAccess, setNetworkAccess] = useState<NetworkAccess>('team');
  const [review, setReview] = useState(false);
  const [referenceSelections, setReferenceSelections] = useState<
    Record<string, KnowledgeBaseRunOverrides>
  >({});
  const referenceRepoId = typeof payload.connectionId === 'string' ? payload.connectionId : '';
  const referenceKey = `${template.id}:${referenceRepoId}`;
  const references = referenceSelections[referenceKey] ?? {};
  const [attempted, setAttempted] = useState(false);
  const lock = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  // Set when the run started but the gateway attached advisory warnings: the form stays on
  // screen so the person reads them before leaving.
  const [notice, setNotice] = useState<{ requestId: string; messages: string[] } | null>(null);
  const launch = useRunTemplate(template.id);
  const { data: connections = [] } = useRepositories();
  useEffect(() => {
    if (notice) {
      noticeRef.current?.querySelector('button')?.focus();
    }
  }, [notice]);
  const failure = launch.isError ? describeLaunchError(launch.error) : null;
  const unchanged = failure?.runAnyway ? failure : null;
  const sampleField = pickSampleField(schema);
  const preview = useTicketPreview();
  const [previewKey, setPreviewKey] = useState('');
  const ticketIdValue = typeof payload.ticketId === 'string' ? payload.ticketId : '';
  const currentPreviewKey = `${referenceRepoId}\n${ticketIdValue}`;
  // A preview answers only for the ticket and repository it was asked about.
  const previewIsCurrent = previewKey === currentPreviewKey;
  const previewResult = previewIsCurrent ? (preview.data ?? null) : null;
  const previewErrorMessage =
    previewIsCurrent && preview.isError
      ? preview.error instanceof ApiError && preview.error.status === 503
        ? TRACKER_UNREACHABLE
        : 'Could not look up that ticket. Try again.'
      : null;
  const trackerConfigured = previewResult ? previewResult.configured : null;
  const ticket = ticketFieldState(schema, payload, trackerConfigured);
  const errors = schema
    ? applyTicketErrors(schema, payload, validatePayload(schema, payload), trackerConfigured)
    : {};
  const required = new Set(schema?.required ?? []);
  // A workspace provider can need a target connection the input schema never asks for; the
  // launch is refused without one, so the form has to collect it.
  const providerConnectionTypes =
    template.workspaceProvider && isWorkspaceProviderType(template.workspaceProvider)
      ? (getWorkspaceProviderMetadata(template.workspaceProvider)?.connectionTypes ?? [])
      : [];
  const schemaHasConnection = Object.entries(schema?.properties ?? {}).some(
    ([key, prop]) => key === 'connectionId' && prop.type === 'connection'
  );
  const needsConnection = providerConnectionTypes.length > 0 && !schemaHasConnection;
  const connectionError =
    needsConnection && !payload.connectionId ? 'Choose a connection to run against' : undefined;
  function displayValue(key: string, value: unknown) {
    if (schema?.properties[key]?.type === 'connection' || key === 'connectionId') {
      const connection = connections.find((item) => item.id === value);
      return connection ? connectionLabel(connection) : 'Selected connection';
    }
    const property = schema?.properties[key];
    if (
      Array.isArray(property?.enum) &&
      (typeof value === 'string' || typeof value === 'number') &&
      property.enum.includes(value)
    ) {
      return humanizeWorkflowKey(String(value));
    }
    if (property?.type === 'array' && Array.isArray(property.items?.enum) && Array.isArray(value)) {
      return value.map((item) => humanizeWorkflowKey(String(item))).join(', ');
    }
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  function fieldLabel(key: string) {
    return workflowFieldLabel(key, schema?.properties[key]);
  }
  function reviewInputs() {
    setAttempted(true);
    if (!Object.keys(errors).length && !connectionError) {
      setReview(true);
    }
  }
  async function submit(acknowledgeUnchanged?: true) {
    if (lock.current || launch.isSuccess) {
      return;
    }
    lock.current = true;
    try {
      const result = await launch.mutateAsync({
        ...(label.trim() ? { label: label.trim() } : {}),
        payload: submitPayload(schema, payload),
        ...knowledgeBaseOverrideBody(references),
        ...egressPolicyFor(networkAccess),
        ...(acknowledgeUnchanged ? { acknowledgeUnchanged } : {}),
      });
      if (result.warnings?.length) {
        // The lock stays set: the run exists, so no second launch is possible from here.
        setNotice({
          messages: [...new Set(result.warnings.map((warning) => warning.message))],
          requestId: result.workRequestId,
        });
      } else {
        onLaunched(result.workRequestId);
      }
    } catch {
      lock.current = false;
    }
  }
  return (
    <Card className="space-y-5">
      <LaunchCardHeader
        description={
          review
            ? 'Check what will run, then launch it.'
            : `Name this task and fill in what ${workflowPresentation(template).title} needs.`
        }
        stage={review ? 'review' : 'details'}
        title={review ? 'Review and launch' : 'Task details'}
      />
      {notice && (
        <div className="space-y-3">
          <Alert variant="success">Your workflow has started.</Alert>
          <Alert title="Check the description" variant="warning">
            <ul className="list-disc space-y-1 pl-4">
              {notice.messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
            <p className="mt-2">
              The run was not blocked. Review the description if it contains text you did not write.
            </p>
            <div className="mt-3" ref={noticeRef}>
              <Button onClick={() => onLaunched(notice.requestId)} variant="primary">
                Continue to request
              </Button>
            </div>
          </Alert>
        </div>
      )}
      {launch.isError &&
        (unchanged ? (
          <Alert title={unchanged.title}>
            {unchanged.message} {unchanged.hint}
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <Button disabled={launch.isPending} onClick={() => submit(true)} variant="secondary">
                Run anyway
              </Button>
              {unchanged.previousRunId && (
                <Link className="underline" href={`/runs/${unchanged.previousRunId}`}>
                  View the earlier run
                </Link>
              )}
            </div>
          </Alert>
        ) : (
          <Alert>{errMsg(launch.error, 'Could not start the workflow')}</Alert>
        ))}
      {review ? (
        <>
          <ReviewList
            items={[
              ...(label.trim() ? [{ label: 'Task', value: label.trim() }] : []),
              ...(references.add?.length || references.exclude?.length
                ? [
                    {
                      label: 'Knowledge bases',
                      value: `${references.add?.length ?? 0} additions, ${references.exclude?.length ?? 0} exclusions. Mandatory defaults remain enabled.`,
                    },
                  ]
                : []),
              {
                label: 'Workflow',
                value: `${template.name} · active version ${template.activeVersion}`,
              },
              ...Object.entries(payload).map(([key, value]) => ({
                label: fieldLabel(key),
                multiline: true,
                value: displayValue(key, value),
              })),
              {
                label: 'Network access',
                value: NETWORK_ACCESS_OPTIONS.find((option) => option.value === networkAccess)
                  ?.label,
              },
            ]}
          />
          {(template.experimentSplit ?? 0) > 0 && (
            <Alert title="Experiment enabled" variant="info">
              This request may use version {template.experimentVersion} instead of the active
              version.
            </Alert>
          )}
          {showProcessSummary && <WorkflowLaunchSummary templateId={template.id} />}
          <Alert variant="info">
            This workflow follows its configured steps, checks, and approvals. Review its process in
            the workflow library if you need to confirm what it may publish.
          </Alert>
          <div className="flex flex-wrap justify-end gap-3 border-t border-ink-600 pt-4">
            <Button
              disabled={launch.isPending || launch.isSuccess}
              onClick={() => setReview(false)}
              variant="ghost"
            >
              Back to details
            </Button>
            <Button
              disabled={launch.isPending || launch.isSuccess}
              onClick={() => submit()}
              variant="primary"
            >
              {launch.isPending ? 'Starting…' : 'Launch workflow'}
            </Button>
          </div>
        </>
      ) : (
        <>
          {sampleField && (
            <SampleTaskButton
              blocked={label.trim() !== '' || hasText(payload[sampleField])}
              caption={`Fills in the task name and the “${fieldLabel(sampleField)}” field with a small documentation request. Other fields stay as they are.`}
              onFill={() => {
                setLabel(WORKFLOW_SAMPLE.label);
                setPayload((prev) => ({ ...prev, [sampleField]: WORKFLOW_SAMPLE.text }));
              }}
            />
          )}
          <Input
            hint={TASK_NAME_HINT}
            id={taskNameId}
            label="Task name"
            maxLength={200}
            onChange={(event) => setLabel(event.target.value)}
            value={label}
          />
          {schema &&
            Object.entries(schema.properties)
              .sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)))
              .map(([key, prop]) => (
                <div className="space-y-2" key={key}>
                  <SchemaFieldInput
                    error={attempted ? errors[key] : undefined}
                    hint={
                      key === 'ticketId' && ticket.ticketHint
                        ? ticket.ticketHint.text
                        : key === 'description' && ticket.descriptionOptional
                          ? DESCRIPTION_HINT_WITH_TICKET
                          : undefined
                    }
                    hintTone={key === 'ticketId' ? ticket.ticketHint?.tone : undefined}
                    name={key}
                    onChange={(value) => setPayload((prev) => ({ ...prev, [key]: value }))}
                    prop={prop}
                    required={
                      required.has(key) && !(key === 'description' && ticket.descriptionOptional)
                    }
                    value={payload[key]}
                  />
                  {key === 'ticketId' && ticket.hasTicket && referenceRepoId && (
                    <TicketTitleLookup
                      canFetch={ticket.ticketValid}
                      errorMessage={previewErrorMessage}
                      isPending={preview.isPending}
                      onFetch={() => {
                        setPreviewKey(currentPreviewKey);
                        preview.mutate({ connectionId: referenceRepoId, ticketId: ticketIdValue });
                      }}
                      onUseAsName={(title) => setLabel(title.slice(0, 200))}
                      result={previewResult}
                    />
                  )}
                </div>
              ))}
          {needsConnection && (
            <ConnectionPicker
              connectionTypes={providerConnectionTypes}
              error={attempted ? connectionError : undefined}
              label="Target connection"
              onChange={(value) => setPayload((prev) => ({ ...prev, connectionId: value }))}
              required
              value={typeof payload.connectionId === 'string' ? payload.connectionId : ''}
            />
          )}
          <KnowledgeBasePicker
            key={referenceKey}
            onChange={(value) =>
              setReferenceSelections((current) => ({ ...current, [referenceKey]: value }))
            }
            repoId={
              connections.find((connection) => connection.id === referenceRepoId)?.type ===
              'git_repo'
                ? referenceRepoId
                : undefined
            }
            teamId={
              connections.find((connection) => connection.id === referenceRepoId)?.team?.id ??
              template.team?.id
            }
            templateId={template.id}
            value={references}
          />
          <Select
            hint={NETWORK_ACCESS_HINT}
            label="Network access"
            onChange={(v) => setNetworkAccess(parseNetworkAccess(v))}
            options={NETWORK_ACCESS_OPTIONS}
            value={networkAccess}
          />
          <div className="flex justify-end border-t border-ink-600 pt-4">
            <Button onClick={reviewInputs} variant="primary">
              Review workflow
              <Icon name="arrowRight" size={14} />
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
