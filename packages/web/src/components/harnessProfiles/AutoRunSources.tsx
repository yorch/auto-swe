import { Alert } from '@/components/ui/Alert';
import type { AutoRunSource } from '@/hooks/useHarnessProfiles';
import { visibleText } from '@/lib/visibleText';
import { keyed } from './profileDisplay';

/** The text beside the box that gates turning hooks on, here and at approval. */
export const HOOKS_REVIEWED_LABEL = 'I have reviewed these hook sources';

/**
 * Every file the plugin's latest version runs on its own when hooks are on: path, kind and the
 * commands in it. A file that could not be read is shown with the reason and counts as unsafe.
 * All strings came from the repository, so they go through `visibleText`.
 */
export function AutoRunSources({ sources }: { sources: AutoRunSource[] }) {
  if (sources.length === 0) {
    return (
      <p className="text-xs text-paper-500" data-testid="auto-run-none">
        This version declares no hook sources.
      </p>
    );
  }
  return (
    <Alert announce={false} title="Hook sources that will run" variant="warning">
      <div className="space-y-3" data-testid="auto-run-sources">
        {sources.map((s) => (
          <section aria-label={`Hook source: ${visibleText(s.path)}`} key={`${s.kind}:${s.path}`}>
            <div className="text-xs font-medium">
              {visibleText(s.path)} <span className="text-paper-500">({visibleText(s.kind)})</span>
            </div>
            {s.unreadable ? (
              <p className="text-xs text-danger-400">
                Could not be read, treated as unsafe: {visibleText(s.unreadable)}
              </p>
            ) : (
              <ul className="space-y-0.5 font-mono text-xs">
                {keyed(s.commands).map((c) => (
                  <li className="break-all" key={c.key}>
                    {visibleText(c.text)}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </Alert>
  );
}
