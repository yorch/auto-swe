'use client';

import { useState } from 'react';
import { Alert } from '@/components/ui/Alert';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import {
  type KnowledgeBaseLink,
  type KnowledgeBaseTarget,
  useEffectiveKnowledgeBases,
  useKnowledgeBaseLinks,
  useKnowledgeBases,
  useWriteKnowledgeBaseLink,
} from '@/hooks/useKnowledgeBases';
import { useRepositories } from '@/hooks/useRepositories';
import { errMsg } from '@/lib/errors';
import { visibleText } from '@/lib/visibleText';

export function KnowledgeBaseLinksPanel(props: Parameters<typeof KnowledgeBaseLinksSection>[0]) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="rounded-lg border border-ink-500 p-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm text-paper-200">Knowledge bases</summary>
      {open && (
        <div className="mt-3">
          <KnowledgeBaseLinksSection {...props} />
        </div>
      )}
    </details>
  );
}

function LinkRow({
  link,
  name,
  target,
}: {
  link: KnowledgeBaseLink;
  name: string;
  target: KnowledgeBaseTarget;
}) {
  const write = useWriteKnowledgeBaseLink(target);
  const [ref, setRef] = useState(link.ref ?? '');
  const [mountName, setMountName] = useState(link.mountName ?? '');
  const [mandatory, setMandatory] = useState(link.mandatory);
  return (
    <div className="space-y-3 rounded-md border border-ink-500 p-4">
      <p className="font-medium text-paper-200">
        {name}
        {link.exclude ? ' · excluded' : ''}
      </p>
      {!link.exclude && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label={`${name} ref`}
            maxLength={200}
            onChange={(e) => setRef(e.target.value)}
            value={ref}
          />
          <Input
            label={`${name} mount name`}
            maxLength={80}
            onChange={(e) => setMountName(e.target.value)}
            value={mountName}
          />
        </div>
      )}
      {target.scope === 'TEAM' && (
        <Checkbox
          checked={mandatory}
          label={`Mandatory ${name}`}
          onChange={(e) => setMandatory(e.target.checked)}
        />
      )}
      {write.isError && <Alert>{errMsg(write.error, 'Could not update the link.')}</Alert>}
      <div className="flex gap-2">
        {!link.exclude && (
          <Button
            disabled={write.isPending}
            onClick={() =>
              write.mutate({
                action: 'update',
                body: {
                  mountName: mountName.trim() || null,
                  ref: ref.trim() || null,
                  ...(target.scope === 'TEAM' ? { mandatory } : {}),
                },
                id: link.id,
              })
            }
          >
            Save link
          </Button>
        )}
        <Button
          disabled={write.isPending}
          onClick={() => write.mutate({ action: 'delete', id: link.id })}
          variant="danger"
        >
          {link.exclude ? 'Restore inheritance' : 'Remove link'}
        </Button>
      </div>
    </div>
  );
}

export function KnowledgeBaseLinksSection({
  target,
  teamId,
  canManage,
  global = false,
}: {
  target: KnowledgeBaseTarget;
  teamId?: string | null;
  canManage: boolean;
  global?: boolean;
}) {
  const [id, setId] = useState('');
  const [ref, setRef] = useState('');
  const [mountName, setMountName] = useState('');
  const [mandatory, setMandatory] = useState(false);
  const [previewRepo, setPreviewRepo] = useState('');
  const bases = useKnowledgeBases();
  const links = useKnowledgeBaseLinks(target, canManage);
  const repos = useRepositories({ limit: 500 });
  const repoId = target.scope === 'REPO' ? target.repoId : previewRepo || undefined;
  const inherited = useEffectiveKnowledgeBases({
    enabled: target.scope !== 'TEAM',
    repoId,
    teamId,
  });
  const effective = useEffectiveKnowledgeBases({
    repoId,
    teamId,
    templateId: target.scope === 'TEMPLATE' ? target.templateId : undefined,
  });
  const write = useWriteKnowledgeBaseLink(target);
  const name = (key: string) => visibleText(bases.data?.find((kb) => kb.id === key)?.name ?? key);
  return (
    <Card className="space-y-4">
      <h2 className="text-lg font-semibold text-paper-100">Knowledge bases</h2>
      <p className="text-sm text-paper-400">
        {target.scope === 'TEAM'
          ? 'Team defaults are inherited by runs. Mandatory references cannot be excluded.'
          : 'Read-only third-party reference material. Links affect future resolutions, not running snapshots.'}
      </p>
      {canManage ? (
        <>
          <QueryBoundary
            {...links}
            label="knowledge base links"
            onRetry={() => void links.refetch()}
          >
            {links.data?.length === 0 && (
              <EmptyState
                hint="Add a reference below to make it available to runs."
                icon="layers"
                title="No knowledge base links"
              />
            )}
            {links.data?.map((link) => (
              <LinkRow
                key={`${link.id}:${link.ref}:${link.mountName}:${link.mandatory}`}
                link={link}
                name={name(link.knowledgeBaseId)}
                target={target}
              />
            ))}
          </QueryBoundary>
          <QueryBoundary {...bases} label="knowledge bases" onRetry={() => void bases.refetch()}>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label="Knowledge base to link"
                onChange={setId}
                options={(bases.data ?? [])
                  .filter(
                    (kb) =>
                      kb.status === 'OK' &&
                      (!global || kb.visibility === 'ORG') &&
                      !links.data?.some((link) => link.knowledgeBaseId === kb.id)
                  )
                  .map((kb) => ({ label: visibleText(kb.name), value: kb.id }))}
                value={id}
              />
              <Input
                hint="Blank uses the KB default ref."
                label="Link ref"
                maxLength={200}
                onChange={(e) => setRef(e.target.value)}
                value={ref}
              />
              <Input
                hint="Blank uses the KB mount name."
                label="Link mount name"
                maxLength={80}
                onChange={(e) => setMountName(e.target.value)}
                value={mountName}
              />
            </div>
            {target.scope === 'TEAM' && (
              <Checkbox
                checked={mandatory}
                label="Mandatory for team runs"
                onChange={(e) => setMandatory(e.target.checked)}
              />
            )}
            {global && (
              <p className="text-sm text-paper-400">
                Global templates can link organization-visible KBs. Each run still checks its own
                team and organization.
              </p>
            )}
            <Button
              disabled={!id || write.isPending || links.isError || links.isLoading}
              onClick={() =>
                write.mutate(
                  {
                    action: 'add',
                    body: {
                      exclude: false,
                      knowledgeBaseId: id,
                      mandatory: target.scope === 'TEAM' && mandatory,
                      mountName: mountName.trim() || null,
                      ref: ref.trim() || null,
                    },
                  },
                  {
                    onSuccess: () => {
                      setId('');
                      setRef('');
                      setMountName('');
                      setMandatory(false);
                    },
                  }
                )
              }
            >
              Add link
            </Button>
          </QueryBoundary>
          {write.isError && <Alert>{errMsg(write.error, 'Could not change the links.')}</Alert>}
        </>
      ) : (
        <p className="text-sm text-paper-400">An owning-team lead manages these links.</p>
      )}
      {target.scope === 'TEMPLATE' && (
        <Select
          label="Preview repository (optional)"
          onChange={setPreviewRepo}
          options={[
            { label: 'Team defaults only', value: '' },
            ...(repos.data ?? [])
              .filter((repo) => repo.type === 'git_repo' && (!teamId || repo.team.id === teamId))
              .map((repo) => ({
                label: `${repo.organizationName}/${repo.repoName}`,
                value: repo.id,
              })),
          ]}
          value={previewRepo}
        />
      )}
      {target.scope === 'TEMPLATE' && canManage && (repoId || teamId) && (
        <QueryBoundary
          {...inherited}
          label="inherited references"
          onRetry={() => void inherited.refetch()}
        >
          <h3 className="text-sm font-medium text-paper-200">Exclude an inherited reference</h3>
          {[...(inherited.data?.selected ?? []), ...(inherited.data?.dropped ?? [])].map((kb) => (
            <div
              className="flex items-center justify-between gap-3 text-sm text-paper-300"
              key={kb.knowledgeBaseId}
            >
              <span>
                {name(kb.knowledgeBaseId)} · {kb.source}
                {kb.mandatory ? ' · mandatory — locked' : ''}
              </span>
              <Button
                disabled={
                  kb.mandatory ||
                  write.isPending ||
                  links.data?.some((link) => link.knowledgeBaseId === kb.knowledgeBaseId)
                }
                onClick={() =>
                  write.mutate({
                    action: 'add',
                    body: {
                      exclude: true,
                      knowledgeBaseId: kb.knowledgeBaseId,
                      mandatory: false,
                      mountName: null,
                      ref: null,
                    },
                  })
                }
              >
                Exclude
              </Button>
            </div>
          ))}
        </QueryBoundary>
      )}
      {(repoId || teamId) && (
        <QueryBoundary
          {...effective}
          label="effective knowledge bases"
          onRetry={() => void effective.refetch()}
        >
          <h3 className="text-sm font-medium text-paper-200">Effective set preview</h3>
          {effective.data?.selected.length === 0 && (
            <p className="text-sm text-paper-400">No references selected.</p>
          )}
          {effective.data?.selected.map((kb) => (
            <p className="text-sm text-paper-300" key={kb.knowledgeBaseId}>
              {name(kb.knowledgeBaseId)} · {kb.source}
              {kb.mandatory ? ' · mandatory' : ''} · {visibleText(kb.ref ?? 'Default ref')}
            </p>
          ))}
          {!!effective.data?.dropped.length && (
            <p className="text-sm text-paper-400">
              Outside the four-KB cap:{' '}
              {effective.data.dropped.map((kb) => name(kb.knowledgeBaseId)).join(', ')}
            </p>
          )}
        </QueryBoundary>
      )}
    </Card>
  );
}
