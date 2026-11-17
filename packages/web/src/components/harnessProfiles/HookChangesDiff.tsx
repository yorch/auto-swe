import { Alert } from '@/components/ui/Alert';
import type { HarnessProfileHookChanges } from '@/hooks/useHarnessProfiles';
import { visibleText } from '@/lib/visibleText';
import { hasHookChanges, keyed } from './profileDisplay';

function Commands({ prefix, commands }: { prefix: '+' | '-'; commands: string[] }) {
  return (
    <ul className="space-y-0.5 font-mono text-xs">
      {keyed(commands).map((c) => (
        <li
          className={prefix === '+' ? 'text-success-400' : 'text-danger-400'}
          key={`${prefix}${c.key}`}
        >
          <span aria-hidden="true">{prefix} </span>
          <span className="break-all">{visibleText(c.text)}</span>
        </li>
      ))}
    </ul>
  );
}

/** A hook file the server could not read: its commands are unknown, so it counts as unsafe. */
function Unreadable({ reason }: { reason: string }) {
  return (
    <p className="text-xs text-danger-400" data-testid="hook-unreadable">
      Could not be read, treated as unsafe: {visibleText(reason)}
    </p>
  );
}

/**
 * What an update does to the plugin's hook files, command by command. Hook commands run inside
 * the run container with the agent's authority, so this is the part of an update to read closest.
 * Every string comes from the repository and is shown through `visibleText`.
 */
export function HookChangesDiff({ changes }: { changes: HarnessProfileHookChanges }) {
  if (!hasHookChanges(changes)) {
    return (
      <p className="text-xs text-paper-500" data-testid="hook-changes-none">
        This update changes no hook files.
      </p>
    );
  }
  return (
    <Alert announce={false} title="Hook changes" variant="warning">
      <div className="space-y-3" data-testid="hook-changes">
        {changes.added.map((h) => (
          <section aria-label={`Hook file added: ${visibleText(h.path)}`} key={`a:${h.path}`}>
            <div className="text-xs font-medium">Added {visibleText(h.path)}</div>
            {h.unreadable ? (
              <Unreadable reason={h.unreadable} />
            ) : (
              <Commands commands={h.commands} prefix="+" />
            )}
          </section>
        ))}
        {changes.changed.map((h) => (
          <section aria-label={`Hook file changed: ${visibleText(h.path)}`} key={`c:${h.path}`}>
            <div className="text-xs font-medium">Changed {visibleText(h.path)}</div>
            {h.unreadable ? (
              <Unreadable reason={h.unreadable} />
            ) : (
              <>
                <Commands commands={h.removedCommands} prefix="-" />
                <Commands commands={h.addedCommands} prefix="+" />
              </>
            )}
          </section>
        ))}
        {changes.removed.map((h) => (
          <section aria-label={`Hook file removed: ${visibleText(h.path)}`} key={`r:${h.path}`}>
            <div className="text-xs font-medium">Removed {visibleText(h.path)}</div>
            {h.unreadable ? (
              <Unreadable reason={h.unreadable} />
            ) : (
              <Commands commands={h.commands} prefix="-" />
            )}
          </section>
        ))}
      </div>
    </Alert>
  );
}
