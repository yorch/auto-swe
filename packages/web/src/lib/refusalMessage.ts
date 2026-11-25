import { CATALOG, isCapabilityKey } from '@auto-swe/shared/permissions/client';
import { orgRoleLabel, teamRoleLabel } from './roleLabels';

/**
 * Plain wording for a server capability refusal. The gateway answers 403 `FORBIDDEN` with a
 * `message` such as "Requires LEAD in this team or ADMIN in the team's organization" and
 * `missing`, the capability key. This turns the pair into "Needs a Team lead in this team or an
 * Org admin in the team's organization. Covers: create, change and delete event automations."
 *
 * Anything it cannot parse (a handwritten refusal, an unknown key, a deactivated-team message)
 * comes back as the original message, so the result is never less informative than the input.
 */
export function refusalMessage(message: string, missing?: string | null): string {
  const match = /^Requires (.+)$/.exec(message.trim());
  if (!match) {
    return message;
  }
  const clauses: string[] = [];
  for (const part of match[1].split(' or ')) {
    const clause = /^([A-Z_]+) in (this team|the team's organization|this organization)$/.exec(
      part.trim()
    );
    if (!clause) {
      return message;
    }
    const [, role, where] = clause;
    const label = where === 'this team' ? teamRoleLabel(role) : orgRoleLabel(role);
    clauses.push(`${article(label)} ${label} in ${where}`);
  }
  const needs = `Needs ${clauses.join(' or ')}.`;
  const description = missing && isCapabilityKey(missing) ? CATALOG[missing].description : null;
  if (!description) {
    return needs;
  }
  const covers = description.replace(/\.$/, '');
  return `${needs} Covers: ${covers.charAt(0).toLowerCase()}${covers.slice(1)}.`;
}

function article(label: string): string {
  return /^[aeiou]/i.test(label) ? 'an' : 'a';
}
