## What this changes, and why

<!-- The problem first. If it changes behaviour a comment explains, quote that comment. -->

## Checks

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run check:publishable`
- [ ] `npm run check:licences`

## If this touches retrieval or a guard

- [ ] The refusal guarantee still holds: `open` refuses a path no listing offered.
- [ ] Examples added to tests are invented, not taken from a real organisation.

<!--
The two known issues in docs/KNOWN-ISSUES.md are both cases where the obvious fix
was tried, measured, and made things worse. If you are changing one of them, say
what you measured.
-->
