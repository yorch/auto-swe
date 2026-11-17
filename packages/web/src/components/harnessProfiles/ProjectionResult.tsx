import { Alert } from '@/components/ui/Alert';
import type { ProjectionResult as Projection } from '@/hooks/useHarnessProfiles';
import { visibleText } from '@/lib/visibleText';
import { keyed } from './profileDisplay';

function Names({ label, names }: { label: string; names: string[] }) {
  if (names.length === 0) {
    return null;
  }
  return (
    <div>
      <span className="font-medium">{label}:</span>{' '}
      <span className="font-mono text-xs">{names.map((n) => visibleText(n)).join(', ')}</span>
    </div>
  );
}

/**
 * The plugin skills an approval projected into the skill library for runtimes other than
 * Claude Code. A problem here never undoes the approval, so it is reported, not raised.
 */
export function ProjectionResult({ projection }: { projection: Projection | null }) {
  if (!projection) {
    return null;
  }
  const { created, updated, refused, failed } = projection;
  const none = created.length === 0 && updated.length === 0 && refused.length === 0 && !failed;
  return (
    <div className="space-y-2" data-testid="projection-result">
      {failed && (
        <Alert variant="warning">
          The approval stands, but projecting the plugin’s skills into the skill library failed.
          Runs on other runtimes will not see them.
        </Alert>
      )}
      {none && !failed ? (
        <p className="text-xs text-paper-500">The plugin has no skills to project.</p>
      ) : (
        <div className="space-y-1 text-sm text-paper-300">
          <Names label="Skills created" names={created} />
          <Names label="Skills updated" names={updated} />
        </div>
      )}
      {refused.length > 0 && (
        <Alert announce={false} title="Skills not projected" variant="warning">
          <ul className="list-disc space-y-0.5 pl-5">
            {keyed(refused.map((r) => `${r.name}: ${r.reason}`)).map((r) => (
              <li key={r.key}>{visibleText(r.text)}</li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}
