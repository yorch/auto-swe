import { Alert } from '@/components/ui/Alert';

/**
 * The model-related advisories a saved agent can carry. The agent is saved either way: the
 * catalog says the model is unpriced, deprecated or the wrong kind, and the credential list says
 * nothing reachable can authenticate its provider (or that a custom provider has no `apiBase`).
 */
export function ModelSaveWarnings({
  catalogWarnings,
  credentialWarnings,
  runtimeWarnings,
}: {
  catalogWarnings?: string[];
  credentialWarnings?: string[];
  runtimeWarnings?: string[];
}) {
  return (
    <>
      {catalogWarnings && catalogWarnings.length > 0 && (
        <Alert variant="warning">Model catalog: {catalogWarnings.join(' ')}</Alert>
      )}
      {credentialWarnings && credentialWarnings.length > 0 && (
        <Alert variant="warning">Credentials: {credentialWarnings.join(' ')}</Alert>
      )}
      {runtimeWarnings && runtimeWarnings.length > 0 && (
        <Alert variant="warning">
          Saved, but agents on the Claude Code harness inherit this model, which the harness cannot
          drive. Their runs fail until they get an Anthropic model of their own or move to the
          Mastra loop:
          <ul className="mt-1 list-disc pl-5">
            {runtimeWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
    </>
  );
}
