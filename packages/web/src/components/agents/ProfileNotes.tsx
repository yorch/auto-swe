import { Alert } from '@/components/ui/Alert';
import { visibleText } from '@/lib/visibleText';

/**
 * Plugins dropped from a new team override's starting value because the team has not enabled
 * them. The override is saved either way; a team admin enables the plugin and binds it again.
 */
export function ProfileNotes({ notes }: { notes?: string[] }) {
  if (!notes || notes.length === 0) {
    return null;
  }
  return (
    <Alert variant="warning">
      Some plugins of the platform-wide agent were not carried over:
      <ul className="mt-1 list-disc pl-5">
        {notes.map((n) => (
          <li key={n}>{visibleText(n)}</li>
        ))}
      </ul>
    </Alert>
  );
}
