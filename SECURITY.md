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

## For operators

Core is designed to run without managed dependencies and without outbound calls
other than to the model provider you configure. If you are running it in a
restricted environment and something reaches for the network unexpectedly, treat
that as a bug and report it.
