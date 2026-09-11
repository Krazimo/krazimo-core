# Security policy

## Reporting a vulnerability

Email **security@krazimo.com** with a description, affected version, and steps to
reproduce. Please do not open a public issue for anything exploitable.

We aim to acknowledge within 2 business days and to agree a disclosure timeline
with you before anything is published.

## Supported versions

This project is pre-1.0. Only the latest published version receives fixes, and a
patch may arrive as a minor release because `0.x` makes no compatibility promise.

| Version | Supported |
|---|---|
| latest `0.1.x` | yes |
| anything older | no |

## Scope

This repository is the agent engine. It has no concept of a tenant, holds no
credentials, and performs no authentication — those belong to the operator of the
deployment.

Areas we consider in scope:

- **Prompt injection via knowledge base content.** Documents are untrusted input.
  Content that attempts to redirect the agent's instructions should be detected
  and fenced, not obeyed.
- **Path traversal in retrieval.** A path not present in a listing must be refused.
- **Data exfiltration through tool arguments or model output.**
- **Dependency supply chain.**

Out of scope: anything requiring the operator to have already misconfigured
credentials, and the behaviour of models themselves.

## What reaches your logs

An operator processing personal data needs to know where a user's words can end up.
Core writes to `stdout`/`stderr` in exactly three places, and this is all of them.

| Where | When | What |
|---|---|---|
| `policy/screen.ts` | The scope screen returns a verdict it cannot read | Up to 120 characters of the **classifier's reply**, not the user's message |
| `policy/screen.ts` | The scope screen throws | The error message only |
| `agent/index.ts` | Only when `KZ_DEBUG_USAGE` is set | Token counts and provider metadata. No message text |

Two things worth being precise about, because the difference matters to a reviewer:

- **The user's message is never logged directly.** What the first row prints is what the
  screening model returned. A misbehaving classifier can quote the input back to itself,
  so treat it as potentially user-derived, but it is not a copy of the message.
- **It is a fallback path, not the normal one.** It fires when a screen fails, which is
  also the moment the turn proceeds unscreened, so the line exists precisely because
  falling open silently was worse.

Core takes no logger and calls `console` directly, so there is currently no way to
redirect or suppress this from the outside. If you need that, say so in an issue: an
injectable logger is a small change and nobody has asked for it yet.

## For operators

Core is designed to run without managed dependencies and without outbound calls
other than to the model provider you configure. If you are running it in a
restricted environment and something reaches for the network unexpectedly, treat
that as a bug and report it.
