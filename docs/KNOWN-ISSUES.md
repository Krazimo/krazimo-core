# Known issues

## `resolveNear` cannot correct a near-miss whose directory is also wrong

`IndexWalk.#resolveNear` only searches the directory the model named. The comment
above it cites this motivating case:

> "Train to Tier One/Tier Two guide.md" for "train-to-tier-onetwo-guide.md"

That case does **not** resolve, because the slash inside the display title makes
the directory `rank/Train to Tier One`, which does not exist — so there is nothing
to search and the open is refused.

Carried over faithfully from the original implementation, which has the same
behaviour. Recorded rather than fixed because widening the search is exactly the
change that was already tried and reverted once: resolving against the whole tree
dropped coverage 15 → 13 and citation 93% → 83%, turning visible refusals into
invisible wrong answers.

A narrower fix — search the *parent* directory when the named one does not exist,
still requiring an unambiguous match — is plausible but must be validated against
the eval suites before it lands, not reasoned about.

## `unsourced` needs distinctive digits, and once did not have them

`sourced()` compares a claim's digits against the digits in what the agent read,
so `$1,200` and `1200` are recognised as the same claim. The first version applied
that to *every* number, which meant "1–3 drops per 5 mL" was made of 1, 3 and 5 —
digits that appear somewhere in any library of any size — so every invented
dilution ratio counted as sourced and the guard never fired.

Now: numbers of three or more digits match on digits, everything else must match
as a phrase. Found by the grounded suite, on precisely the case that guard exists
for, which is the argument for running it.
