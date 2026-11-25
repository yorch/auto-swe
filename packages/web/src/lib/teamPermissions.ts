import { runControlWho } from '@/lib/gateAnswerers';
import { repoManagersPhrase } from '@/lib/roleLabels';

/**
 * Why a control is unavailable. What a person may DO is read from the server's effective
 * permissions (`useCan`, `hooks/useCan.ts`); these only word the explanation next to a control
 * that is shown disabled.
 */

/** Why a repository control is unavailable; names the owner, which is not the caller's team. */
export function repoManageReason(ownerTeamName: string | null | undefined, action: string): string {
  return `Only ${repoManagersPhrase(ownerTeamName)} can ${action} this repository.`;
}

/** Why a menu entry on a repository is unavailable, for items that are not named in the message. */
export function repoLeadReason(ownerTeamName: string | null | undefined): string {
  return `Only ${repoManagersPhrase(ownerTeamName)} can do this.`;
}

/** Why a run control is unavailable: the rule includes the owning team, the launcher and platform admins. */
export function runControlReason(ownerTeamName: string | null | undefined, action: string): string {
  return runControlWho(ownerTeamName, action);
}
