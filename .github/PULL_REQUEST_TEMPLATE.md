<!--
Thanks for contributing to evmsec! Please fill this in so reviewers have the
context they need. Delete sections that don't apply.
-->

## What does this PR do?

<!-- A short summary of the change and the motivation behind it. -->

## Type of change

- [ ] Bug fix
- [ ] New security check / command
- [ ] Bridge route added to `bridges.json`
- [ ] Tooling / CI / docs
- [ ] Other:

## Checklist

- [ ] `npm run check` passes locally (format, lint, typecheck, tests)
- [ ] Added or updated tests for any new pure logic
- [ ] Updated `README.md` / `CHANGELOG.md` if behavior changed

## For a new bridge route only

- [ ] Every escrow and token address cites a **primary source** in `notes` (the
      bridge's own docs or an explorer-verified contract — not a third-party
      list)
- [ ] `npm run evmsec -- solvency <id>` returns a plausible backing ratio
