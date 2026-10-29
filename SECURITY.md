# Security Policy

## Reporting a vulnerability

Please report vulnerabilities **privately** via GitHub Security Advisories: open the repository's **Security** tab → **Report a vulnerability**. Do not open a public issue or pull request for security problems.

Include what you can: affected component (gateway / worker / web / shared / cli), reproduction steps, impact assessment, and any suggested fix.

This is a small project maintained on a best-effort basis — reports are read and triaged, but **no response-time or fix SLA is promised**.

## Scope

In scope: the code in this repository (the `auto-swe` monorepo) — the Fastify gateway, Temporal worker, Next.js dashboard, shared library, and CLI, plus the shipped Docker/compose configuration.

Out of scope:

- Third-party dependencies (report upstream; a dependency-bump request here is fine).
- Self-hosted infrastructure you run it on (your Postgres, Temporal, Docker hosts, reverse proxy).
- Vulnerabilities requiring an already-compromised host or admin credentials.
- Findings in target repositories that the agents operate on.

## Fixed defects that need action from you

A fix that changes what an earlier build already did to your deployment (a credential that reached a log, a Pod object or a process list) cannot be undone by upgrading alone. [`docs/upgrade-notes.md`](./docs/upgrade-notes.md) lists each one by the condition that makes you affected and the fixing commit, with what to rotate or purge and how to verify the fix is running.

Of particular interest: auth/RBAC bypasses, secret exposure (`CONFIG_ENCRYPTION_KEY`-encrypted credentials, tokens), Docker workspace sandbox escapes, webhook signature bypasses, and prompt-injection paths that defeat the runtime security scanners.
