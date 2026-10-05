import { Badge } from '@/components/ui/Badge';
import type { FieldChange } from '@/lib/agentDiff';
import { cn } from '@/lib/utils';

/** Renders the output of `diffAgentVersions`: one block per changed field. */
export function VersionDiff({ changes }: { changes: FieldChange[] }) {
  if (changes.length === 0) {
    return <p className="text-sm text-paper-500">No differences in the saved settings.</p>;
  }
  return (
    <div className="space-y-4">
      {changes.map((change) => (
        <section key={change.label}>
          <h4 className="label-mono mb-1.5">{change.label}</h4>
          {change.kind === 'text' && (
            <div className="space-y-1 text-sm">
              <div className="rounded-sm bg-brick-400/10 px-2 py-1 text-paper-300">
                <span className="mr-2 text-brick-400">−</span>
                {change.before || <span className="text-paper-500">empty</span>}
              </div>
              <div className="rounded-sm bg-moss-400/10 px-2 py-1 text-paper-200">
                <span className="mr-2 text-moss-400">+</span>
                {change.after || <span className="text-paper-500">empty</span>}
              </div>
            </div>
          )}
          {change.kind === 'list' && (
            <div className="flex flex-wrap items-center gap-1.5">
              {change.added.map((x) => (
                <Badge key={`+${x}`} tone="moss" variant="text">
                  + {x}
                </Badge>
              ))}
              {change.removed.map((x) => (
                <Badge key={`-${x}`} tone="brick" variant="text">
                  − {x}
                </Badge>
              ))}
              {change.reordered && <span className="text-xs text-paper-500">Order changed</span>}
            </div>
          )}
          {change.kind === 'prompt' && (
            <pre className="max-h-80 overflow-auto rounded-md border border-ink-600 bg-ink-900 p-2 text-xs">
              {change.lines.map((line, i) => (
                <div
                  className={cn(
                    'whitespace-pre-wrap break-words px-1',
                    line.kind === 'added' && 'bg-moss-400/10 text-paper-100',
                    line.kind === 'removed' && 'bg-brick-400/10 text-paper-300',
                    line.kind === 'same' && 'text-paper-500'
                  )}
                  // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines have no identity; the list is never reordered
                  key={i}
                >
                  <span aria-hidden="true" className="mr-2 select-none">
                    {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                  </span>
                  {line.text || ' '}
                </div>
              ))}
            </pre>
          )}
        </section>
      ))}
    </div>
  );
}
