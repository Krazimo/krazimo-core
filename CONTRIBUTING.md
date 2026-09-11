# Contributing

Thanks for looking. This is a small, opinionated engine, so the most useful thing
you can do before writing code is open an issue describing the problem you hit.

## Getting set up

```bash
npm install       # also points git at the repo's own hooks
npm run build
npm test
```

Node 20 or newer. There is no external test runner: tests compile to `dist-test/`
and run on Node's built-in one.

## Before you push

`npm install` sets `core.hooksPath` to the committed `.githooks/` directory, so the
gates run on commit and push without any further setup. They are:

```bash
npm run typecheck
npm test
npm run check:publishable
npm run check:licences
```

`check:publishable` is the unusual one and it will probably be the first thing that
stops you. This repository is public and is developed alongside a private one, so no
client name, credential, or internal system reference may enter it — including in a
comment or a test fixture. The check enforces that with a denylist *and* a positive
allowlist of every proper noun the repo is allowed to contain, because a denylist
only knows the names we have already leaked once.

If it stops you, the answer is usually to reword rather than to add an allowlist
entry. **Write invented examples.** A guard test needs *a* rank and *a* figure, never
a real organisation's rank and its real figure.

## What makes a good change

**Comments say why, not what.** They record decisions, including reversed ones. If
you are changing behaviour a comment explains, read the comment first — several of
them exist because the obvious fix was tried and measured and made things worse.

**Do not weaken the refusal guarantee.** `open` refusing a path that no listing
offered is the property the whole design exists to provide. A change that makes
retrieval more forgiving needs evidence, not reasoning, because that exact change has
been tried before and turned visible refusals into invisible wrong answers.

**Keep the boundary.** Core has no concept of a tenant, and no authentication,
metering or billing. It must boot with nothing managed: a knowledge base, an agent
config and a model credential. If a change means core cannot start without a
database, that is a bug in the change.

## Style

Tabs in `src/`. Relative imports carry a `.js` extension even though the source is
TypeScript. Type-only imports say `import type`. `strict` is on, along with
`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, so indexing an array
gives you `T | undefined` and you have to handle it.

There is no formatter, so match the file you are in.

## Security

Please do not open a public issue for anything exploitable. See
[SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contributions are licensed under Apache-2.0, the
same terms as the project.
