import { checkProbeUrl } from '@auto-swe/shared/lib/ssrfGuard';
import { ApplicationFailure } from '@temporalio/activity';

/**
 * An ADMIN-configured connector origin on a platform-wide integration (the
 * tracker at /admin/integrations → Tracker, the knowledge base at → Knowledge
 * Base) and whether that integration opted in to private addresses.
 */
export interface AdminConnectorOrigin {
  allowPrivateNetwork: boolean;
  baseUrl: string | null;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * The SSRF check for a connector `baseUrl` stored on a `Connection` row.
 *
 * That URL is on a row a team LEAD can edit, and the worker sends the
 * connection's credential to it — so an unchecked URL lets a LEAD aim the worker
 * (and the token) at loopback, a cloud metadata endpoint or any internal
 * service.
 *
 * The `allowPrivateNetwork` opt-in is therefore honoured only for the exact
 * origin an ADMIN configured on the platform-wide integration, never from the
 * connection row: an opt-in a LEAD could set on their own connection would be no
 * guard at all. The opt-in waives only the private-address refusal
 * (`checkProbeUrl`); loopback, link-local and cloud-metadata addresses,
 * unspecified addresses and malformed or non-http(s) URLs are always refused.
 * With no admin configuration the strict check alone applies.
 *
 * `label` names the connector in the refusal, so a failure says which connection
 * the operator has to fix.
 */
export async function assertSafeConnectionBaseUrl(
  baseUrl: string,
  admin: AdminConnectorOrigin | null,
  label: string
): Promise<{ allowPrivate: boolean }> {
  const strict = checkProbeUrl(baseUrl);
  // The opt-in is per origin and applies whether or not the text check passed: a
  // named host that resolves to a private address passes the text check and is
  // refused only at connect time.
  const optedIn = Boolean(
    admin?.allowPrivateNetwork && admin.baseUrl && sameOrigin(admin.baseUrl, baseUrl)
  );
  if (strict.ok) {
    // The host text is not refused as private, so it is a public destination
    // however it later resolves: the credential goes over TLS. `optedIn` still
    // governs whether the connection may reach a *private address* at connect
    // time — a name that passes this check can still resolve into one — but it is
    // permission to reach private addresses, not a transport exception, so it
    // must not let a public host be reached in clear.
    if (strict.url.protocol !== 'https:') {
      throw ApplicationFailure.nonRetryable(
        `${label} connection baseUrl must be https (got '${strict.url.protocol}')`
      );
    }
    return { allowPrivate: optedIn };
  }
  // Refused by the strict check. Only a private-address refusal is waivable, and
  // only for the exact origin an admin opted in (`checkProbeUrl` returns a
  // non-private refusal unchanged, whatever the flag says). Plain HTTP is allowed
  // here and only here: an internal host is usually reached that way, and the hop
  // is already inside the trust boundary the opt-in establishes.
  if (optedIn && checkProbeUrl(baseUrl, { allowPrivate: true }).ok) {
    return { allowPrivate: true };
  }
  throw ApplicationFailure.nonRetryable(
    `${label} connection baseUrl rejected by the SSRF guard: ${strict.reason}`
  );
}
