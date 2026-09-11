# krazimo-core

A grounded agent engine for TypeScript. Give it a folder of documents and an agent
config, and it answers from those documents, cites the ones it opened, and declines
when they do not cover the question.

The guarantee it is built around: **the agent cannot open a document that was never
listed to it.** Not "is discouraged from" — the tool refuses. An answer either came
from a document that exists, or it did not happen.

```
open("wellness/sleep/insomnia-cure.md")
→ refused. Did you mean waking-in-the-night.md?
```

That refusal is enforced in code, not asked for in a prompt, which is what makes
grounding something you can test rather than something you hope for.

## Installation

```bash
npm install @krazimo/core
```

Node 20 or newer. No database, no vector store, no managed service. Memory defaults
to the filesystem and Postgres is opt-in.

## Getting started

A knowledge base is a directory of markdown. An `INDEX.md` in a folder is what the
agent is allowed to see of that folder, so the index is how you control navigation.

```
knowledge/
  INDEX.md
  sleep/
    INDEX.md
    waking-in-the-night.md
```

An agent is a YAML file pointing at that directory and at a policy.

```yaml
# agent.yaml
metadata:
  id: wellness
  name: Wellness guide
execution_policy:
  model: openrouter:anthropic/claude-sonnet-5
  max_steps: 8
knowledge_bases:
  - mount_as: wellness
    root: ./knowledge
policy: ./policy.yaml
retrieval:
  strategy: index-walk
```

```yaml
# policy.yaml
id: wellness
version: 1
constitution: |
  Answer only from the knowledge base. Cite what you opened.
  If the knowledge base does not cover it, say so.
guards:
  - id: no_invented_dosage
    detect: "\\b\\d+\\s*(mg|ml)\\b"
    unsourced: true
    action: strip
```

Then run a turn.

```ts
import { loadAgent, runTurn } from "@krazimo/core";

const agent = loadAgent("./agent.yaml");

const turn = await runTurn(
  {
    id: agent.id,
    policy: agent.policy,
    retrieval: agent.retrieval,
    model: agent.model,
    maxSteps: agent.maxSteps,
  },
  { message: "I keep waking at 3am. What helps?" },
);

console.log(turn.answer);
console.log(turn.decision); // "answered" | "declined" | "escalated"
console.log(turn.sources);  // only documents actually opened
```

`turn.transcript` is the full message array. Hand it back as the next turn's
`transcript` and the documents already read stay read, so a follow-up answers from
what it has instead of reopening the same pages.

## How it works

### Retrieval

The `index-walk` strategy gives the model three tools: `list` a folder, `open` a
document, `find` by words. It walks the tree the way a person would. There is no
similarity search in the path, because a nearest neighbour is something the model
cannot verify and an exact filename is.

Large documents are paged rather than truncated, and the window is announced, so
the model knows there is more and can ask for it.

`vector` and `hybrid` strategies are designed for but not built. Naming one throws
at load rather than silently serving a different guarantee.

### Policy

A policy is data, not code, so behaviour can be reviewed and versioned without a
deploy. It carries three things:

**A constitution**, the written standard the agent is held to.

**A scope screen**, which classifies whether a message is in scope. It is advisory
and **fails open** on purpose: a classifier hiccup must not refuse a real question.
It is not the enforcing layer.

**Output guards**, which are the enforcing layer, and are deterministic. They run
*after* generation and match on the answer, not the prompt. A guard can strip a
figure, replace a sentence, or force a retry. The `unsourced` flag is the useful
one: fire only when the detected text is absent from what the agent actually read,
so a number that appears in an opened document passes and the same number appearing
from nowhere does not.

Everything in the guard list was tried as a prompt instruction first and failed.

### Models

Bedrock and OpenRouter today, behind one resolver. A model is a string:
`bedrock:...` routes one way, anything else the other. Credentials resolve the way
the provider's own tooling resolves them, and are never cached.

### Memory

An interface with a filesystem default. Facts are extracted from a turn and
rendered into a brief that is prepended to the next message, labelled rather than
bare, because an unlabelled list of facts next to a question reads to a model as a
shortlist to answer from.

## Project layout

```
src/agent       the loop and its step budget
src/retrieval   strategy interface + index-walk
src/policy      constitution, scope screen, output guards
src/models      provider routing
src/memory      interface, extraction, rendering
test/fixtures   small knowledge bases the retrieval tests walk
scripts         repo gates
```

Everything listed is on disk. See [docs/DESIGN.md](docs/DESIGN.md) for the reasoning
and [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) for what is currently wrong.

## Development

```bash
npm run build       # tsc -> dist/
npm run typecheck
npm test            # 80 tests on Node's built-in runner
npm run test:coverage
```

`npm install` also installs the repo's git hooks, which run the same gates before a
commit and a push.

## Status

This is a library. There is no HTTP server, no command line interface and no
container image yet; a single-agent HTTP surface is the next thing planned. Tenancy,
authentication, metering, billing and a console are not part of this project and are
not planned for it.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
gates your change has to pass and the two properties not to break.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
