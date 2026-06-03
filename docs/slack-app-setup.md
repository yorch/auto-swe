# Slack app setup

The `slack-app-manifest.json` next to this file is a [Slack app manifest](https://api.slack.com/reference/manifests) you can import to provision the auto-swe Slack app in one step.

## Steps

1. Visit https://api.slack.com/apps → **Create New App** → **From an app manifest**.
2. Pick your workspace.
3. Paste the contents of `docs/slack-app-manifest.json`.
4. Replace the two `https://YOUR-GATEWAY-HOST/...` placeholders with your gateway's externally reachable host:
   - `slash_commands[0].url` → `/api/v1/auth/slack/commands`
   - `settings.interactivity.request_url` → `/api/v1/auth/slack/interactive`
   - `oauth_config.redirect_urls[0]` → `/api/v1/auth/slack/callback`
5. **Create**, then **Install to Workspace** to grant the bot scopes.

## Endpoints the manifest assumes

All under the gateway's `/api/v1/auth/slack` prefix (phase 7):

| Endpoint | Used by |
|---|---|
| `POST /commands` | `/auto-swe` slash command (HMAC-verified via `SLACK_SIGNING_SECRET`) |
| `POST /interactive` | Modal submissions (`/auto-swe run` workflow picker) |
| `GET  /callback` | OAuth redirect target after the user clicks the install URL |
| `GET  /connect` | Linkage flow surfaced in the unknown-Slack-user ephemeral hint |

## Bot scopes

`chat:write`, `chat:write.public`, `commands`, `users:read`, `users:read.email` — the minimum set needed for slash-command handling, channel posts, and resolving Slack users to platform users.

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
