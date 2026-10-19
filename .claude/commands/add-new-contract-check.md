---
name: add-new-contract-check
description: Workflow command scaffold for add-new-contract-check in evmsec.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /add-new-contract-check

Use this workflow when working on **add-new-contract-check** in `evmsec`.

## Goal

Implements a new on-chain contract security check (e.g., admin-power, oracle-hygiene, compiler-bugs, verification-status, freeze-authority), integrating it into the CLI, tests, documentation, and audit suite.

## Common Files

- `src/checks/<check>.ts`
- `src/<check>-core.ts`
- `src/<check>-core.test.ts`
- `src/commands/<check>.ts`
- `src/index.ts`
- `README.md`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Implement core check logic in src/checks/<check>.ts and/or src/<check>-core.ts
- Write unit tests for the check in src/<check>-core.test.ts or src/freeze-core.test.ts
- Add a CLI command in src/commands/<check>.ts
- Register the check in src/index.ts and/or the audit suite
- Update documentation: README.md, CHANGELOG.md, docs/IMPROVEMENTS.md

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.