# Design

The reasoning behind the engine. Implementation detail lives in comments beside the
code it explains; this file is for the decisions those comments assume.

## The guarantee

An agent may only open a document that a listing offered it. `open` refuses anything
else, and says what does exist nearby.

This is the whole design. Everything below follows from wanting that property to be
checkable rather than hoped for:

- **No similarity search in the retrieval path.** A nearest neighbour is a result the
  model cannot verify; an exact filename is one it can. Ranking by embedding would
  make "where did this come from" a question about a score.
- **Navigation is the index.** A folder's `INDEX.md` is what the agent can see of that
  folder, so controlling what an agent may reach is editing a document, not writing
  code.
- **Refusal is a tool outcome, not a prompt instruction.** A prompt asking a model not
  to invent a citation is a request. A tool that returns `refused` is a fact.

The payoff is that "did it invent this source?" stops being a question about the model
and becomes one the tool already answered.

## Policy is data

A policy is a document: a constitution, an optional scope screen, escalations, and
output guards. None of it is compiled in.

It began as code, and moving it out is what made a second deployment possible at all
and what made behaviour reviewable, because a policy version is something a person
responsible for compliance can read and sign.

Two rules hold the line:

1. **Guards are deterministic and run after generation.** Every guard in the library
   was tried as a prompt instruction first and failed. A guard matches the answer, not
   the question, and it is a regular expression rather than a model, so it either fired
   or it did not.
2. **The scope screen fails open.** It classifies, and when the classifier is
   unreadable or errors, the turn proceeds. Refusing a real question because a
   classifier timed out is a worse product than occasionally answering something off
   topic, and the guards still run either way. The screen is advisory; the guards
   enforce.

## Boundary rules

These decide most arguments before they start.

1. **Core has no concept of a tenant.** No tenancy, no authentication, no metering, no
   billing, no console.
2. **Core boots with no managed dependency.** Filesystem memory by default, no
   database. If core cannot start without something managed, that is a bug.
3. **Nothing hosted sits in the critical path.** Every external dependency needs a
   self-hostable alternative behind its interface.
4. **No client name, credential, or internal system reference enters this repository**,
   including in commit messages. `npm run check:publishable` enforces this, and it is
   not only a list of known names — see the header of `scripts/check-publishable.mjs`
   for why a denylist alone cannot work.

## What is not settled

`vector` and `hybrid` retrieval strategies are designed for and not built. Naming one
throws at load rather than quietly serving a different guarantee than the config asked
for.

Memory extraction is deliberately simple and has not been measured against an
alternative.

See [KNOWN-ISSUES.md](KNOWN-ISSUES.md) for behaviour that is wrong and recorded rather
than fixed.
