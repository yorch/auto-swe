'use client';

import { useMemo, useState } from 'react';
import { VersionDiff } from '@/components/agents/VersionDiff';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmModal } from '@/components/ui/ConfirmModal';
import { QueryBoundary } from '@/components/ui/QueryBoundary';
import { Table, Td, THead, Th, TRow } from '@/components/ui/Table';
import { type Skill, useRestoreSkillRevision, useSkillRevisions } from '@/hooks/useSkills';
import { type FieldChange, lineDiff } from '@/lib/agentDiff';
import { formatDate } from '@/lib/utils';
import { visibleText } from '@/lib/visibleText';

/**
 * The saved revisions of one skill with what changed in each, and a way back. A restore saves the
 * old text as a new revision, so runs pinned to any revision keep reading it.
 */
export function SkillHistory({
  onRestored,
  skill,
}: {
  /** Called with the saved skill after a restore, so the caller shows the revision it just made. */
  onRestored?: (skill: Skill) => void;
  skill: Skill;
}) {
  const { data: revisions, error, isError, isLoading } = useSkillRevisions(skill.id);
  const restore = useRestoreSkillRevision();
  const [selected, setSelected] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ revision: number; warnings: string[] } | null>(null);

  const selectedRevision = selected ?? revisions?.[0]?.revision ?? null;
  const index = revisions?.findIndex((r) => r.revision === selectedRevision) ?? -1;
  const current = index >= 0 ? revisions?.[index] : undefined;
  const previous = index >= 0 ? revisions?.[index + 1] : undefined;
  const changes = useMemo<FieldChange[]>(() => {
    if (!(current && previous)) {
      return [];
    }
    const out: FieldChange[] = [];
    // Stored text keeps bidi and zero-width characters; show them as markers before diffing.
    const prevDescription = visibleText(previous.description ?? '');
    const currDescription = visibleText(current.description ?? '');
    if (prevDescription !== currDescription) {
      out.push({
        after: currDescription,
        before: prevDescription,
        kind: 'text',
        label: 'Description',
      });
    }
    const prevText = visibleText(previous.promptText, { multiline: true });
    const currText = visibleText(current.promptText, { multiline: true });
    if (prevText !== currText) {
      out.push({
        kind: 'prompt',
        label: 'Prompt text',
        lines: lineDiff(prevText, currText),
      });
    }
    return out;
  }, [current, previous]);

  return (
    <section aria-label="Revision history" className="space-y-4 border-t border-ink-600 pt-4">
      <h3 className="text-sm font-medium text-paper-100">Revision history</h3>
      {notice && (
        <Alert variant={notice.warnings.length > 0 ? 'warning' : 'success'}>
          Saved as revision {notice.revision}.
          {notice.warnings.length > 0 &&
            ` The content scanner flagged the text: ${notice.warnings.join('; ')}`}
        </Alert>
      )}
      <QueryBoundary error={error} isError={isError} isLoading={isLoading} label="revisions">
        <Table>
          <THead>
            <Th variant="compact">Revision</Th>
            <Th variant="compact">Saved</Th>
            <Th variant="compact" />
          </THead>
          <tbody>
            {(revisions ?? []).map((r) => (
              <TRow
                className={r.revision === selectedRevision ? 'bg-ink-800' : undefined}
                key={r.id}
              >
                <Td className="py-2 pr-3">
                  <span className="tabular-nums text-paper-100">#{r.revision}</span>
                  {r.isCurrent && (
                    <Badge className="ml-2" tone="moss" variant="text">
                      Current
                    </Badge>
                  )}
                </Td>
                <Td className="py-2 pr-3 text-xs text-paper-400">
                  {formatDate(r.createdAt)}
                  {r.createdByEmail && <div className="text-paper-500">{r.createdByEmail}</div>}
                </Td>
                <Td className="py-2 text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      aria-label={`Show what changed in revision ${r.revision}`}
                      onClick={() => setSelected(r.revision)}
                      size="sm"
                      variant="ghost"
                    >
                      Changes
                    </Button>
                    {!(r.isCurrent || skill.isBuiltIn) && (
                      <Button
                        aria-label={`Restore revision ${r.revision} as a new revision`}
                        onClick={() => setRestoring(r.revision)}
                        size="sm"
                        variant="secondary"
                      >
                        Restore
                      </Button>
                    )}
                  </div>
                </Td>
              </TRow>
            ))}
          </tbody>
        </Table>
        {current && (
          <div>
            <h4 className="mb-2 text-sm text-paper-300">
              {previous
                ? `What changed from #${previous.revision} to #${current.revision}`
                : `#${current.revision} is the first revision`}
            </h4>
            {previous && <VersionDiff changes={changes} />}
          </div>
        )}
      </QueryBoundary>
      <ConfirmModal
        confirmLabel="Restore as new revision"
        message={`This saves the text of revision ${restoring ?? ''} as a new revision. Nothing is deleted, runs already in progress keep the text they started with, and the skill needs verifying again.`}
        onClose={() => setRestoring(null)}
        onConfirm={async () => {
          if (restoring !== null) {
            const res = await restore.mutateAsync({ id: skill.id, revision: restoring });
            setNotice({ revision: res.skill.currentRevision, warnings: res.scanWarnings });
            onRestored?.(res.skill);
            setSelected(null);
            setRestoring(null);
          }
        }}
        open={restoring !== null}
        pendingLabel="Restoring…"
        title={`Restore revision ${restoring ?? ''}?`}
      />
    </section>
  );
}
