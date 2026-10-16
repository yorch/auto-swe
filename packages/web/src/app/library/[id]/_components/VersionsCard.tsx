import type { WorkflowTemplateDetail } from '@auto-swe/shared/types/api';
import { HelpTip } from '@/components/ui/HelpTip';
import { VersionTags } from '@/components/workflow/VersionTags';
import { cn, FOCUS_RING, formatDate, formatRelativeTime } from '@/lib/utils';
import { RailCard } from './RailCard';

interface VersionsCardProps {
  template: WorkflowTemplateDetail;
  effectiveVersion: number | null;
  /** Unsaved edits: a click then asks before discarding them. */
  isDirty: boolean;
  onAskDiscard: (version: number) => void;
  onSelectVersion: (version: number) => void;
}

/** The right rail's version list; clicking a version selects it (or asks first when dirty). */
export function VersionsCard({
  template,
  effectiveVersion,
  isDirty,
  onAskDiscard,
  onSelectVersion,
}: VersionsCardProps) {
  return (
    <RailCard
      help={<HelpTip term="version" />}
      hint={template.versions.length > 1 ? String(template.versions.length) : undefined}
      title={template.versions.length > 1 ? 'Versions' : 'Version'}
    >
      <ul className="-mx-1.5 space-y-0.5">
        {template.versions.map((v) => {
          const selected = effectiveVersion === v.version;
          return (
            <li key={v.id}>
              <button
                aria-current={selected ? 'true' : undefined}
                className={cn(
                  'w-full rounded-md px-2.5 py-2 text-left transition-colors',
                  FOCUS_RING,
                  selected
                    ? 'bg-ink-600/70 text-paper-50'
                    : 'text-paper-300 hover:bg-ink-700/60 hover:text-paper-100'
                )}
                disabled={template.versions.length === 1}
                onClick={() => (isDirty ? onAskDiscard(v.version) : onSelectVersion(v.version))}
                type="button"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium tabular-nums">v{v.version}</span>
                    <VersionTags
                      active={v.version === template.activeVersion}
                      experiment={v.version === template.experimentVersion}
                      needsReview={!!v.generatedBy && !v.reviewedAt}
                    />
                  </span>
                  <span className="shrink-0 text-xs text-paper-500" title={formatDate(v.createdAt)}>
                    {formatRelativeTime(v.createdAt)}
                  </span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
      {template.versions.length === 1 && (
        <p className="mt-2 text-xs leading-relaxed text-paper-500">
          Saving a change creates a second version and unlocks comparing and A/B testing.
        </p>
      )}
    </RailCard>
  );
}
