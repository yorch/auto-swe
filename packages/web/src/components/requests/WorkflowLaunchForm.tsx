'use client';

import { isInputSchema } from '@auto-swe/shared/lib/inputSchema';
import {
  getWorkspaceProviderMetadata,
  isWorkspaceProviderType,
} from '@auto-swe/shared/lib/workspaceProviders';
import type { WorkflowTemplateSummary } from '@auto-swe/shared/types/api';
import { useId, useRef, useState } from 'react';
import { WorkflowLaunchSummary } from '@/components/requests/WorkflowLaunchSummary';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import {
  buildInitialPayload,
  ConnectionPicker,
  SchemaFieldInput,
  validatePayload,
} from '@/components/workflow/schemaForm';
import { useRepositories } from '@/hooks/useRepositories';
import { useRunTemplate } from '@/hooks/useTemplates';
import { connectionLabel } from '@/lib/connectionDisplay';
import { errMsg } from '@/lib/errors';

export function WorkflowLaunchForm({
  template,
  onLaunched,
}: {
  template: WorkflowTemplateSummary;
  onLaunched: (requestId: string) => void;
}) {
  const taskNameId = useId();
  const schema = isInputSchema(template.inputSchema) ? template.inputSchema : null;
  const [payload, setPayload] = useState<Record<string, unknown>>(
    schema ? buildInitialPayload(schema) : {}
  );
  const [label, setLabel] = useState('');
  const [review, setReview] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const lock = useRef(false);
  const launch = useRunTemplate(template.id);
  const { data: connections = [] } = useRepositories();
  const errors = schema ? validatePayload(schema, payload) : {};
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
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  function reviewInputs() {
    setAttempted(true);
    if (!Object.keys(errors).length && !connectionError && label.trim()) {
      setReview(true);
    }
  }
  async function submit() {
    if (lock.current || launch.isSuccess) {
      return;
    }
    lock.current = true;
    try {
      const result = await launch.mutateAsync({ label: label.trim(), payload });
      onLaunched(result.workRequestId);
    } catch {
      lock.current = false;
    }
  }
  return (
    <Card className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">{review ? 'Review and launch' : 'Task details'}</h2>
        <p className="mt-1 text-sm text-paper-400">{template.description || template.name}</p>
      </div>
      {launch.isError && <Alert>{errMsg(launch.error, 'Could not start the workflow')}</Alert>}
      {review ? (
        <>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-paper-400">Task</dt>
              <dd className="break-words">{label}</dd>
            </div>
            <div>
              <dt className="text-paper-400">Workflow</dt>
              <dd>
                {template.name} · active version {template.activeVersion}
              </dd>
            </div>
            {Object.entries(payload).map(([key, value]) => (
              <div key={key}>
                <dt className="text-paper-400">
                  {schema?.properties[key]?.type === 'connection' || key === 'connectionId'
                    ? 'Target connection'
                    : key.replace(/([A-Z])/g, ' $1')}
                </dt>
                <dd className="whitespace-pre-wrap break-words">{displayValue(key, value)}</dd>
              </div>
            ))}
          </dl>
          {(template.experimentSplit ?? 0) > 0 && (
            <p className="text-sm text-paper-400">
              An experiment is enabled: this request may use version {template.experimentVersion}{' '}
              instead of the active version.
            </p>
          )}
          <WorkflowLaunchSummary templateId={template.id} />
          <Alert variant="info">
            This workflow follows its configured steps, checks, and approvals. Review its process in
            the workflow library if you need to confirm what it may publish.
          </Alert>
          <div className="flex justify-end gap-3">
            <Button
              disabled={launch.isPending || launch.isSuccess}
              onClick={() => setReview(false)}
              variant="ghost"
            >
              Back to details
            </Button>
            <Button
              disabled={launch.isPending || launch.isSuccess}
              onClick={submit}
              variant="primary"
            >
              {launch.isPending ? 'Starting…' : 'Launch workflow'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <Input
            error={attempted && !label.trim() ? 'Name this task before continuing' : undefined}
            hint="A short name to find this request later."
            id={taskNameId}
            label="Task name"
            maxLength={200}
            onChange={(event) => setLabel(event.target.value)}
            required
            value={label}
          />
          {schema &&
            Object.entries(schema.properties).map(([key, prop]) => (
              <SchemaFieldInput
                error={attempted ? errors[key] : undefined}
                key={key}
                name={key}
                onChange={(value) => setPayload((prev) => ({ ...prev, [key]: value }))}
                prop={prop}
                required={required.has(key)}
                value={payload[key]}
              />
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
          <div className="flex justify-end">
            <Button onClick={reviewInputs} variant="primary">
              Review workflow
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
