# Research — Anthropic's "Claude Tag" (source material)

> **Frozen.** Point-in-time document, preserved for design rationale. It is not maintained: the code and the current references in [`docs/`](../README.md) are authoritative wherever they diverge.

> External product research on Anthropic's **Claude Tag** announcement, compiled
> 2026-06-24 from the official announcement + press coverage. This is the
> **inspiration / reference** for our own implementation; it documents the
> *product we are replicating*, not our code. For what we actually built, see
> [`channel-assistant.md`](../channel-assistant.md).

---

## 1. What it is

**Claude Tag** is a way for teams to work with Claude as a persistent **team
member inside Slack**. Teams grant Claude access to selected channels and
connect it to tools and data; then anyone in a channel can **`@mention`
("tag") Claude** to delegate a task. Announced **2026-06-23**.

It **replaces Anthropic's existing Claude Slack app**, with Team/Enterprise
admins given a **30-day window** to migrate. It is **powered by Claude Opus
4.8**.

## 2. Key features

- **Multiplayer, one shared `@Claude` per channel.** Within a given channel
  there is a *single* Claude that everyone interacts with. Everyone can see what
  it's working on, and people can **pick up the conversation where the last
  person left off** — half-finished tasks hand off between teammates.
- **Persistent memory.** Claude builds context by **remembering relevant
  information from the channels it's in**, so users don't re-explain things.
  Memory is kept **per channel and per workspace**; admins can **view, edit, and
  delete** it.
- **Autonomous multi-stage execution.** Given a task, Claude breaks it into
  stages, works through them independently, and delivers the result back in
  Slack. It can also **plan tasks to complete in the future**.
- **Ambient mode.** Claude **proactively** jumps into chat to keep teams
  updated, flag things from across the organization, and **follow up on
  forgotten threads or tasks**.

## 3. Admin & security controls

- Access to tools, data, and memories can be **very tightly scoped** per
  channel. Admins specify which tools, information, and memories Claude has in
  which channels — e.g. an **HR-team Claude won't leak info to engineering** and
  vice versa.
- It **does not report from private channels**.
- For sensitive data (e.g. personnel data), users can **DM Claude directly** so
  the information doesn't leak into a shared channel.

## 4. Availability & pricing

- **Beta, today**, for **Claude Enterprise and Team** customers. Anthropic's
  stated goal is to expand where `@Claude` is available to many other places
  teams work.
- **No dedicated price** — usage **consumes plan tokens**, with **spend caps
  configurable per channel and per organization** (admins can cap token spend at
  both granularities).

## 5. Notable stat

- Anthropic says tagging `@Claude` is now one of the main ways work gets done
  internally — **~65% of the product team's code is created by their internal
  version of Claude Tag**.

## 6. Reported concerns & limitations

From press coverage and the Hacker News launch discussion:

- **Token cost.** A proactive, memory-heavy agent in a busy workspace generates
  a lot of traffic; every extra summary, follow-up, and context refresh costs
  tokens, so the real bill depends on usage. (The per-channel/per-org spend caps
  are partly a response to this.)
- **Memory hygiene.** Memory helps until it becomes **stale, noisy, or wrong**;
  teams need control over what's retained vs. ignored.
- **Permissions & auditing complexity.** Once an agent is multiplayer, memory,
  permissions, and auditing all get harder.
- **Vendor lock-in.** An agent buried inside one chat app raises lock-in
  questions.

## 7. How this maps to our build

| Claude Tag capability | Our implementation (see `channel-assistant.md`) |
| --- | --- |
| One shared `@Claude` per channel | `SlackChannel` + a channel-resident `channelAssistant` agent; `@mention` → `ChannelAssistantWorkflow` |
| Per-channel scoping of tools/data | `CHANNEL` config-scope tier in the agent resolver cascade; channel-scoped `Agent` rows |
| Per-channel + per-org spend caps | `monthlyBudgetUsdCents` on `SlackChannel` + `ChannelMonthlyUsage`; existing `OrgMonthlyUsage` cap |
| Persistent per-channel memory (view/edit/delete) | channel-scoped `MemoryItem` (`retrieveChannelMemory`/`writeChannelMemory`) + admin view/delete |
| Ambient / proactive mode | per-channel Temporal Schedule → `ChannelAmbientWorkflow` digest |
| DM for sensitive data | Events handler also processes `message.im` DMs |
| Powered by Opus 4.8 | seeded `channelAssistant` agent defaults to `anthropic/claude-opus-4-8` |

## 8. Sources

- [Introducing Claude Tag — Anthropic](https://www.anthropic.com/news/introducing-claude-tag)
- [What is Claude Tag? — Claude Help Center](https://support.claude.com/en/articles/15594475-what-is-claude-tag)
- [Anthropic's Claude Tag is learning your company, one Slack message at a time — TechCrunch](https://techcrunch.com/2026/06/23/anthropics-claude-tag-is-learning-your-company-one-slack-message-at-a-time/)
- [Anthropic launches Claude Tag … a persistent AI teammate that learns, monitors and works autonomously — VentureBeat](https://venturebeat.com/technology/anthropic-launches-claude-tag-replacing-its-slack-app-with-a-persistent-ai-teammate-that-learns-monitors-and-works-autonomously)
- [Anthropic launches Claude Tag, a tool that works like a virtual employee within Slack — Fortune](https://fortune.com/2026/06/23/anthropic-claude-tag-virtual-employee-tool-slack/)
- [Anthropic debuts Claude Tag, a more capable AI teammate that lives within Slack — SiliconANGLE](https://siliconangle.com/2026/06/23/anthropic-debuts-claude-tag-capable-ai-teammate-lives-within-slack/)
- [Anthropic launches Claude Tag enterprise collaborative tool for agentic workflows — 9to5Mac](https://9to5mac.com/2026/06/23/anthropic-launches-claude-tag-enterprise-collaborative-tool-for-agentic-workflows/)
- [Meet Claude Tag, Anthropic's new AI teammate that works in Slack — IT Pro](https://www.itpro.com/software/meet-claude-tag-anthropics-new-ai-teammate-that-works-in-slack)

> Note: figures and claims above (beta scope, 30-day migration window, Opus 4.8,
> the 65% internal-usage stat, pricing model) are as reported at announcement
> (2026-06-23/24) and may change as the product evolves.
