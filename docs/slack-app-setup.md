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
   - `oauth_config.redirect_urls[1]` → `/api/v1/auth/slack/install/callback` (multi-workspace install)
5. **Create**, then **Install to Workspace** to grant the bot scopes (or use the
   one-click "Add to Slack" install flow below for multi-workspace installs).

> **Event URL verification.** When you set the Event Subscriptions request URL, Slack sends a one-time `url_verification` challenge to it. The `/events` endpoint echoes the challenge automatically, so the URL verifies as soon as the gateway is reachable — no manual step. Note: the handshake is signature-verified like every other event, so the **signing secret must be saved in the admin UI (`/admin/integrations → Slack`) before** you complete Slack's Events URL verification — otherwise the challenge is rejected with a 401/503.

## Endpoints the manifest assumes

All under the gateway's `/api/v1/auth/slack` prefix:

| Endpoint | Used by |
|---|---|
| `POST /commands` | `/auto-swe` slash command (HMAC-verified via `SLACK_SIGNING_SECRET`) |
| `POST /interactive` | Modal submissions (`/auto-swe run` picker), HITL buttons, and shortcuts (global "Run a workflow" + message "Ask auto-swe about this") |
| `POST /events` | Slack Events API — the @mention teammate + thread-reply task steering (HMAC-verified; acks within 3s, then starts the assistant workflow or signals an in-flight task run) |
| `GET  /callback` | OAuth redirect target for the account-link flow (`/connect`) |
| `GET  /connect` | Account-link flow surfaced in the unknown-Slack-user ephemeral hint (user scope `identity.basic`) |
| `GET  /install` | One-click app install — redirects to Slack's bot-scope authorize URL (admin-only) |
| `GET  /install/callback` | Install OAuth redirect target — captures the per-workspace bot token |

## Multi-workspace install ("Add to Slack")

One Slack app can be installed into **many workspaces**, each with its own bot
token, via the install flow (`/admin/integrations → Slack → Add to Slack`):

1. An admin clicks **Add to Slack**, which hits `GET /api/v1/auth/slack/install`
   and redirects to Slack's `oauth/v2/authorize` with the app's bot scopes.
2. Slack redirects back to `GET /api/v1/auth/slack/install/callback`, which
   exchanges the code via `oauth.v2.access` and stores the returned `xoxb-…` bot
   token **encrypted** (AES-256-GCM, `CONFIG_ENCRYPTION_KEY`) on the
   `SlackWorkspace` row, along with `appId` / `botUserId` / `installedAt`.
3. The admin lands back on the integrations page; the Slack tab lists each
   workspace's install status (own token vs. singleton fallback).

The **bot token is the only per-workspace secret** — the signing secret + OAuth
client id/secret stay singleton in `SlackConfig` (one app). Every Slack post/read
resolves the per-workspace token by the channel (`C…`) or workspace (`T…`) id it's
acting on (`resolveSlackBotTokenForSlackChannel` / `resolveSlackBotTokenForWorkspace`),
falling back to the singleton `SlackConfig` bot token when a workspace hasn't
completed install — so single-workspace deployments and the legacy single bot
token keep working unchanged.

## @mention teammate (channel assistant)

Once Event Subscriptions are enabled with the `app_mention`, `message.channels`, `message.im`, and `app_home_opened` bot events, the bot becomes a conversational teammate:

- **@mention it in a channel** (`@auto-swe how do I …`) → the gateway strips the mention, auto-provisions a `SlackChannel` row for that channel (mapped to the default team + its org), and starts a `ChannelAssistantWorkflow`. The worker generates the answer and posts it back **in-thread**.
- **DM the bot** → same flow; DMs (`message.im`) are treated like a private thread.
- **Reply in a thread that has an in-flight task run** → the reply **steers** that run instead of starting a fresh turn. The gateway reconstructs the task run's deterministic Temporal id from the channel + thread root and delivers the new guidance via a `steer` signal (a brief ":writing_hand: noted — steering the task." ack lands in-thread). This works for **plain (non-mention) replies too** — which is why the bot now subscribes to `message.channels`. Steering takes precedence: a thread reply that is *also* an `@mention` still steers an active run rather than launching a new turn.

The gateway acks Slack within the 3-second window and starts the workflow (or sends the steer signal) out-of-band, so the HTTP response never waits on the LLM. Redelivered events (`x-slack-retry-num` header) are acked but skipped to avoid duplicate turns. The bot ignores its own messages and Slack system messages (anything with a `bot_id` or `subtype`).

> **Why `message.channels` does not make the bot a firehose.** The bot receives every public-channel message via `message.channels`, but it acts on a plain (non-mention) channel message **only** when it is a thread reply *and* an in-flight task run is bound to that thread (a successful `steer` signal). A non-thread message, or a thread reply with no matching active task, is ignored — it never starts a turn or otherwise responds. So ambient channel chatter stays silent; the subscription exists solely to enable steering an active task by replying in its thread.

The first @mention in a channel auto-creates the channel mapping using the default team from `/admin/workflow → Default team slug` (and that team's owning organization). If the default team is missing, the turn is dropped and a warning is logged — run `yarn db:seed` or create the team first.

## App Home tab (Gap I — packaged UX)

Enable the **App Home** feature in the Slack app config (Home Tab on) and subscribe to the `app_home_opened` bot event. When a user opens the app's **Home** tab, the gateway publishes a Block Kit Home view (via `views.publish`) describing what the assistant does and how to drive it (@mention, thread steering, follow-up sessions, slash commands). The view is static, published per-user on open; the `messages` tab is ignored. No extra bot scope is required beyond `chat:write`.

## Shortcuts

The manifest declares two Slack shortcuts (both delivered to the interactivity endpoint `/api/v1/auth/slack/interactive`, so no extra setup beyond interactivity being enabled):

- **Global shortcut — "Run a workflow"** (`callback_id: auto_swe_run_shortcut`). From Slack's ⚡ composer menu anywhere, opens the same run-picker modal as `/auto-swe run` (`views.open`). Requires a linked account (the modal lists the templates + repos you can access); an unlinked clicker gets a small "link your account first" modal instead of a bare failure (a global shortcut has no channel/`response_url`, so an ephemeral hint can't reach them).
- **Message shortcut — "Ask auto-swe about this"** (`callback_id: auto_swe_ask_shortcut`). From a message's ⋯ (More actions) menu, starts a channel-assistant turn seeded with that message's text and replies in its thread — the same path an `@mention` uses (so it does NOT require the clicker to have linked their account). Text-less messages (file/image only) are skipped rather than spawning an empty turn. The per-message workflow id is deterministic + REJECT_DUPLICATE and namespaced (`chan-<id>-ask-<ts>`) so it never collides with the `@mention` path's `chan-<id>-<ts>` for the same message, and clicking twice is idempotent.

No extra bot scopes are needed beyond those already listed. Adding shortcuts to an installed app requires a reinstall (see the scope-change note below).

## Bot scopes

`app_mentions:read`, `channels:history`, `chat:write`, `chat:write.public`, `commands`, `groups:history`, `im:history`, `users:read`, `users:read.email` — slash-command handling, channel posts, resolving Slack users to platform users, plus receiving @mentions (`app_mentions:read`) and DMs (`im:history`) for the conversational teammate.

The bot now reads the current thread's recent messages via `conversations.replies` to provide full in-thread context on each turn. This requires two additional history scopes beyond the original `im:history`:

- `channels:history` — read message history in public channels
- `groups:history` — read message history in private channels

> **Scope change requires reinstall.** Adding new OAuth scopes to a Slack app requires reinstalling the app to the workspace. After updating the manifest, go to **Settings → Install App** and click **Reinstall to Workspace** to grant the new scopes.

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
