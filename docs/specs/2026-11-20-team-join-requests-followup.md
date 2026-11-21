# Team join requests: closing the known gaps

Status: approved direction. Extends [the team join requests spec](./2026-11-20-team-join-requests.md);
where the two differ, this document wins.

## 1. Decisions

| Gap | Decision |
|---|---|
| Open requests of a deactivated requester or team | Closed in the same transaction as the deactivation, with an audit row. The close helper also supports an organization scope; no deactivation path calls it. |
| Withdraw and re-request loop | Withdrawing starts a short cooldown (`teams.withdrawCooldownHours`, default 1). |
| One person holds both decisions on a cross-organization request | Approving the team step completes the organization step in the same transaction. |
| The team approver's standing at the organization step | Re-checked; a grant above the team approver's current rank is clamped to `MEMBER` and audited. |
| Legacy `POST /api/v1/teams` | Stays platform-admin-only. A test pins that. |
| Directory scope | `teams.directoryScope` is overridable per organization; the team's own organization decides. |
| Notifications | Requester email on a decision; Slack post to the team's channel on a new request; email to organization admins on an organization-step request. Best effort. |
| Truncated request list, organization filter | The web says when the list is cut at 200; the directory returns the organizations it lists. |

## 2. Data model

`TeamJoinRequest` gains `closeReason JoinRequestCloseReason?`. The enum has `REQUESTER_DEACTIVATED`,
`TEAM_DEACTIVATED` and `ORGANIZATION_DEACTIVATED`. `null` means a person decided or withdrew.

A system close sets `WITHDRAWN` with `REQUESTER_DEACTIVATED`, or `REJECTED` with `TEAM_DEACTIVATED` or
`ORGANIZATION_DEACTIVATED`, plus a decision note naming the reason. A system close does not start a
cooldown: only rows with a null `closeReason` count toward the rejection and withdrawal cooldowns.
Reactivating a user or team does not reopen anything. `ORGANIZATION_DEACTIVATED` is a value the close
helper supports for an organization deactivation path; no route deactivates an organization, so nothing
writes it today.

The migration is a new directory sorted after `20261120000000_team_join_requests`.

## 3. Settings

| Key | Change |
|---|---|
| `teams.directoryScope` | `overridableAt` gains `ORGANIZATION`. GLOBAL stays the default for organizations with no override. |
| `teams.withdrawCooldownHours` | New. Integer 0–720, default `1`, GLOBAL, admin write. |
| `teams.joinRequestNotifications` | New. Boolean, default `true`, GLOBAL, admin write. Off stops every notification in section 6. |

Directory rule: a team is listed to a viewer when its organization's resolved `teams.directoryScope`
is `platform`, or the viewer is a member of that organization. The same rule gates creating a request.
Each organization's value is resolved with that organization's id in the context.

## 4. Approval behaviour

- **Combined approval.** When the team step approves a request that needs the organization step, the
  requester is not yet a team member, and the approver also holds `org.members.manage` for the team's organization, the one transaction records both
  decisions: the request becomes `APPROVED`, the organization `MEMBER` and the team membership are created,
  and the audit rows name both steps. The response is the reviewer view with status `APPROVED`. Otherwise
  the request moves to `PENDING_ORG` as before.
- **Organization-step re-check.** A separate organization-step approval re-reads the team step's decider.
  If that person is no longer active, no longer holds `team.members.manage` for the team, or no longer
  outranks `grantedRole`, the granted role becomes `MEMBER`. The audit row of every organization-step
  approval carries `clamp: { clamped, from, to }`: the role the team approver chose, the role applied and
  whether they differ. When the requester already holds the team membership, the role they hold is the
  granted role and `clamped` is false. The request is never refused for this.

## 5. API changes

| Route | Change |
|---|---|
| `GET /teams/directory` | Response gains `organizations: [{ id, name }]`: the organizations with at least one team the viewer may see, sorted by name and capped at 500, with `organizationsTruncated: boolean` when more exist. The only parameter list a directory query carries is the viewer's own organization memberships: an organization's override of the setting is compared in SQL, so neither the number of organizations nor the number of overrides limits the query. `scope` holds only the GLOBAL value of `teams.directoryScope`; each team's own organization decides what is listed. |
| `GET /me/join-requests` and every request view | Views carry `closeReason` (`null` or one of the enum values). |
| `POST /teams/:id/join-requests` | `429 JOIN_REQUEST_COOLDOWN` also covers the withdrawal cooldown; `details.reason` is `rejected` or `withdrawn`. |
| User deactivation, team deactivation | Close open requests per section 2. |

## 6. Notifications

One module, `packages/gateway/src/lib/joinRequestNotifier.ts`, exports:

```ts
export type JoinRequestEvent =
  | { kind: 'created'; requestId: string }
  | { kind: 'decided'; requestId: string; outcome: 'APPROVED' | 'REJECTED' | 'PENDING_ORG' };

export function notifyJoinRequestEvent(prisma: PrismaClient, event: JoinRequestEvent): Promise<void>;
```

The function never throws and never rejects. The service calls it after the transaction commits and does
not await a failure into its own result. It loads what it needs by id.

| Event | Recipient | Channel |
|---|---|---|
| `created` | The team's `slackNotifyChannel`, when set and Slack is configured | Slack post |
| `decided` (`APPROVED`, `REJECTED`) | The requester | Email |
| `decided` (`PENDING_ORG`) | The requester (email), and the organization's `ADMIN` members | Email |

Nothing is sent when `teams.joinRequestNotifications` is false. System closes send nothing. Text that a person
wrote (the request message, a decision note, names) is escaped in HTML and has Slack broadcast mentions
neutralized. A message carries no token and no credential; links point at the web app. Email uses the
SMTP or Resend transport that sign-in emails use; where none is configured the send is skipped with one
warning per gateway process, and a send failure is logged and swallowed. The requester's email address
is never put in a Slack post.

## 7. Web

- The My requests list says when the server reports `meta.truncated`.
- The directory's organization filter lists `organizations` from the response.
- A closed request shows why when `closeReason` is set.
- The team-step approve dialog says that the approval also completes the organization step when the viewer
  holds `org.members.manage` for the team's organization.

## 8. Documentation

`docs/teams.md` drops the limitations this closes and describes the new behaviour;
`docs/configuration.md` lists the new settings; `docs/upgrade-notes.md` gets an entry for the
per-organization scope and for the notification email requirement, and the earlier team-directory entry's
`<fixing commit SHA>` becomes `1187a47`.

## Limitations

- Notification delivery is not retried and not recorded; a failed send is only logged.
- A team with no `slackNotifyChannel` posts nothing on a new request, so its reviewers rely on the queue.
- Reactivating a user or team does not reopen requests that were closed by the deactivation.
- An organization deactivated outside the API (for example directly in the database) keeps its join
  requests open. They keep counting toward each requester's open-request cap, and the approval paths do not
  check the organization's active flag.
