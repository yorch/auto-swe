/**
 * `Connection` rows carry the AES-GCM envelope of the repo API token
 * (`apiKey*` columns). Those bytes must never leave the gateway — a future key
 * exposure would otherwise compromise every historically fetched row — so every
 * route that returns a connection strips them and exposes only whether a token
 * is set, mirroring `redactCredential` for provider credentials.
 */
export interface ConnectionEnvelopeColumns {
  apiKeyCiphertext: Uint8Array | null;
  apiKeyNonce: Uint8Array | null;
  apiKeyAuthTag: Uint8Array | null;
  apiKeyVersion: number;
}

export type RedactedConnection<T> = Omit<T, keyof ConnectionEnvelopeColumns> & {
  hasApiToken: boolean;
};

export function redactConnection<T extends Partial<ConnectionEnvelopeColumns>>(
  row: T
): RedactedConnection<T> {
  const {
    apiKeyAuthTag: _tag,
    apiKeyCiphertext,
    apiKeyNonce: _nonce,
    apiKeyVersion: _v,
    ...rest
  } = row;
  return { ...rest, hasApiToken: apiKeyCiphertext != null };
}
