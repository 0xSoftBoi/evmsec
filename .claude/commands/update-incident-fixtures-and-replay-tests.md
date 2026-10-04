---
name: update-incident-fixtures-and-replay-tests
description: Workflow command scaffold for update-incident-fixtures-and-replay-tests in evmsec.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /update-incident-fixtures-and-replay-tests

Use this workflow when working on **update-incident-fixtures-and-replay-tests** in `evmsec`.

## Goal

Captures and pins real mainnet contract verdicts as offline fixtures for regression testing, ensuring check results are reproducible and credible.

## Common Files

- `scripts/capture-fixtures.ts`
- `src/fixtures/incidents/*.json`
- `src/incident-fixtures.test.ts`
- `README.md`
- `docs/IMPROVEMENTS.md`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Use scripts/capture-fixtures.ts to record on-chain reads and responses
- Add or update JSON fixtures in src/fixtures/incidents/*.json
- Update or add tests in src/incident-fixtures.test.ts to replay and assert expected verdicts
- Update README.md and docs/IMPROVEMENTS.md to reflect new or changed fixtures

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.