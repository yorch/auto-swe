'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Select } from '@/components/ui/Select';
import {
  type KnowledgeBaseRunOverrides,
  useEffectiveKnowledgeBases,
  useKnowledgeBases,
} from '@/hooks/useKnowledgeBases';
import { visibleText } from '@/lib/visibleText';

export function KnowledgeBasePicker({
  repoId,
  teamId,
  templateId,
  value,
  onChange,
}: {
  repoId?: string | null;
  teamId?: string | null;
  templateId?: string;
  value: KnowledgeBaseRunOverrides;
  onChange: (value: KnowledgeBaseRunOverrides) => void;
}) {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const bases = useKnowledgeBases(open);
  const effective = useEffectiveKnowledgeBases({ enabled: open, repoId, teamId, templateId });
  useEffect(() => {
    if (!effective.data || !value.exclude?.length) {
      return;
    }
    const mandatory = new Set(
      [...effective.data.selected, ...effective.data.dropped]
        .filter((kb) => kb.mandatory)
        .map((kb) => kb.knowledgeBaseId)
    );
    if (value.exclude.some((key) => mandatory.has(key))) {
      onChange({ ...value, exclude: value.exclude.filter((key) => !mandatory.has(key)) });
    }
  }, [effective.data, value, onChange]);
  const name = (key: string) => visibleText(bases.data?.find((kb) => kb.id === key)?.name ?? key);
  return (
    <details
      className="rounded-lg border border-ink-500 p-4"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium text-paper-200">
        Knowledge bases · optional
      </summary>
      {open && (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-paper-400">
            Read-only, untrusted third-party references, not instructions. Up to four KBs are
            selected; mandatory defaults take priority. The run team must have access.
          </p>
          {!repoId && !teamId ? (
            <p className="text-sm text-paper-400">
              Choose a repository or a team-owned template to configure references.
            </p>
          ) : (
            <>
              <QueryBoundary
                {...effective}
                label="inherited knowledge bases"
                onRetry={() => void effective.refetch()}
              >
                {effective.data &&
                  [...effective.data.selected, ...effective.data.dropped].map((kb) => (
                    <Checkbox
                      checked={kb.mandatory || !value.exclude?.includes(kb.knowledgeBaseId)}
                      disabled={kb.mandatory}
                      hint={`${kb.ref ?? 'Default ref'}${effective.data.dropped.some((row) => row.knowledgeBaseId === kb.knowledgeBaseId) ? ' · outside the current cap' : ''}`}
                      key={kb.knowledgeBaseId}
                      label={`${name(kb.knowledgeBaseId)} · ${kb.source}${kb.mandatory ? ' · mandatory — locked' : ''}`}
                      onChange={(e) =>
                        onChange({
                          ...value,
                          exclude: e.target.checked
                            ? value.exclude?.filter((key) => key !== kb.knowledgeBaseId)
                            : [...(value.exclude ?? []), kb.knowledgeBaseId],
                        })
                      }
                    />
                  ))}
                {effective.data &&
                  !effective.data.selected.length &&
                  !effective.data.dropped.length && (
                    <EmptyState
                      hint="Add a knowledge base below, or use the team and repository defaults."
                      icon="layers"
                      title="No inherited references"
                    />
                  )}
              </QueryBoundary>
              <QueryBoundary
                {...bases}
                label="available knowledge bases"
                onRetry={() => void bases.refetch()}
              >
                <div className="flex items-end gap-2">
                  <Select
                    className="min-w-0 flex-1"
                    label="Add knowledge base"
                    onChange={setId}
                    options={(bases.data ?? [])
                      .filter(
                        (kb) => kb.status === 'OK' && !value.add?.some((row) => row.id === kb.id)
                      )
                      .map((kb) => ({ label: visibleText(kb.name), value: kb.id }))}
                    value={id}
                  />
                  <Button
                    disabled={!id || (value.add?.length ?? 0) >= 100}
                    onClick={() => {
                      onChange({
                        add: [...(value.add ?? []), { id }],
                        exclude: value.exclude?.filter((key) => key !== id),
                      });
                      setId('');
                    }}
                  >
                    Add
                  </Button>
                </div>
              </QueryBoundary>
              {value.add?.map((row) => (
                <div className="flex items-end gap-2" key={row.id}>
                  <Input
                    className="min-w-0 flex-1"
                    hint="Blank uses the knowledge base default ref."
                    label={`${name(row.id)} ref`}
                    maxLength={200}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        add: value.add?.map((item) =>
                          item.id === row.id
                            ? { id: item.id, ...(e.target.value ? { ref: e.target.value } : {}) }
                            : item
                        ),
                      })
                    }
                    value={row.ref ?? ''}
                  />
                  <Button
                    aria-label={`Remove ${name(row.id)} addition`}
                    onClick={() =>
                      onChange({ ...value, add: value.add?.filter((item) => item.id !== row.id) })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </details>
  );
}
