# Slack app setup

The `slack-app-manifest.json` next to this file is a [Slack app manifest](https://api.slack.com/reference/manifests) you can import to provision the auto-swe Slack app in one step.

## Steps

1. Visit https://api.slack.com/apps → **Create New App** → **From an app manifest**.
2. Pick your workspace.
3. Paste the contents of `docs/slack-app-manifest.json`.
4. Replace the `https://YOUR-GATEWAY-HOST/...` placeholders with your gateway's externally reachable host:
   - `slash_commands[0].url` → `/api/v1/auth/slack/commands`
   - `settings.interactivity.request_url` → `/api/v1/auth/slack/interactive`
   - `settings.event_subscriptions.request_url` → `/api/v1/auth/slack/events`
   - `oauth_config.redirect_urls[0]` → `/api/v1/auth/slack/callback`
5. **Create**, then **Install to Workspace** to grant the bot scopes.

> **Event URL verification.** When you set the Event Subscriptions request URL, Slack sends a one-time `url_verification` challenge to it. The `/events` endpoint echoes the challenge automatically, so the URL verifies as soon as the gateway is reachable — no manual step. Note: the handshake is signature-verified like every other event, so the **signing secret must be saved in the admin UI (`/admin/integrations → Slack`) before** you complete Slack's Events URL verification — otherwise the challenge is rejected with a 401/503.

## Endpoints the manifest assumes

All under the gateway's `/api/v1/auth/slack` prefix (phase 7):

| Endpoint | Used by |
|---|---|
| `POST /commands` | `/auto-swe` slash command (HMAC-verified via `SLACK_SIGNING_SECRET`) |
| `POST /interactive` | Modal submissions (`/auto-swe run` workflow picker) |
| `POST /events` | Slack Events API — the @mention teammate (HMAC-verified; acks within 3s, then starts the assistant workflow) |
| `GET  /callback` | OAuth redirect target after the user clicks the install URL |
| `GET  /connect` | Linkage flow surfaced in the unknown-Slack-user ephemeral hint |

## @mention teammate (Claude Tag)

Once Event Subscriptions are enabled with the `app_mention` and `message.im` bot events, the bot becomes a conversational teammate:

- **@mention it in a channel** (`@auto-swe how do I …`) → the gateway strips the mention, auto-provisions a `SlackChannel` row for that channel (mapped to the default team + its org), and starts a `ChannelAssistantWorkflow`. The worker generates the answer and posts it back **in-thread**.
- **DM the bot** → same flow; DMs (`message.im`) are treated like a private thread.

The gateway acks Slack within the 3-second window and starts the workflow out-of-band, so the HTTP response never waits on the LLM. Redelivered events (`x-slack-retry-num` header) are acked but skipped to avoid duplicate turns. The bot ignores its own messages and Slack system messages (anything with a `bot_id` or `subtype`). Ambient (non-mention) channel chatter is intentionally ignored in this phase.

The first @mention in a channel auto-creates the channel mapping using the default team from `/admin/workflow → Default team slug` (and that team's owning organization). If the default team is missing, the turn is dropped and a warning is logged — run `yarn db:seed` or create the team first.

## Bot scopes

`app_mentions:read`, `chat:write`, `chat:write.public`, `commands`, `im:history`, `users:read`, `users:read.email` — slash-command handling, channel posts, resolving Slack users to platform users, plus receiving @mentions (`app_mentions:read`) and DMs (`im:history`) for the conversational teammate.

## After install

Configure the credentials via the admin UI at `/admin/integrations → Slack tab`:

| Field | Source | Effect |
|---|---|---|
| **Client ID** | **Basic Information** → App Credentials → Client ID | Required for the OAuth `/connect` flow |
| **Client Secret** | **Basic Information** → App Credentials → Client Secret | Required for the OAuth `/connect` flow (restart gateway after saving) |
| **Signing Secret** | **Basic Information** → App Credentials → Signing Secret | Required for HMAC verification of slash commands and interactive payloads |
| **Bot Token** | **OAuth & Permissions** → Bot User OAuth Token (`xoxb-…`) | Required for run notifications and opening modals |

Click **Save**. The signing secret, bot token, and slash-command handling take effect immediately (no restart needed). Changing the client ID or client secret requires a gateway restart.

> **Env var fallback.** `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, and `SLACK_CLIENT_SECRET` environment variables are still accepted as fallbacks when no DB row exists — useful during initial bootstrapping before the admin UI is available.
