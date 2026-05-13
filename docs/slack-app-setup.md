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

- Set `SLACK_BOT_TOKEN` (the `xoxb-…` value from **OAuth & Permissions** → **Bot User OAuth Token**) on the worker so per-step + run-complete notifications can post.
- Set `SLACK_SIGNING_SECRET` (from **Basic Information** → **App Credentials**) on the gateway so slash-command + interactive payload signatures verify.
