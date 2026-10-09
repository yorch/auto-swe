import { Alert } from '@/components/ui/Alert';

/**
 * The model-related advisories a saved agent can carry. The agent is saved either way: the
 * catalog says the model is unpriced, deprecated or the wrong kind, and the credential list says
 * nothing reachable can authenticate its provider (or that a custom provider has no `apiBase`).
 */
export function ModelSaveWarnings({
  catalogWarnings,
  credentialWarnings,
}: {
  catalogWarnings?: string[];
  credentialWarnings?: string[];
}) {
  return (
    <>
      {catalogWarnings && catalogWarnings.length > 0 && (
        <Alert variant="warning">Model catalog: {catalogWarnings.join(' ')}</Alert>
      )}
      {credentialWarnings && credentialWarnings.length > 0 && (
        <Alert variant="warning">Credentials: {credentialWarnings.join(' ')}</Alert>
      )}
    </>
  );
}
