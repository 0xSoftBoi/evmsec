```markdown
# evmsec Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you how to contribute to the `evmsec` TypeScript codebase, which implements on-chain contract security checks for EVM-compatible blockchains. You'll learn the project's coding conventions, how to add new security checks, manage incident fixtures, refactor shared logic, and update documentation. The guide includes practical code examples and step-by-step workflows to streamline your development process.

## Coding Conventions

**File Naming**
- Use `kebab-case` for all file names.
  - Example: `admin-power-core.ts`, `oracle-hygiene.test.ts`

**Import Style**
- Use relative imports.
  - Example:
    ```typescript
    import { checkAdminPower } from './admin-power-core';
    ```

**Export Style**
- Use named exports.
  - Example:
    ```typescript
    export function checkAdminPower(...) { ... }
    ```

**Commit Messages**
- Use [Conventional Commits](https://www.conventionalcommits.org/) with prefixes:
  - `feat`, `refactor`, `fix`, `test`
  - Example: `feat: add oracle hygiene check for price feeds`

## Workflows

### Add New Contract Check
**Trigger:** When you want to implement a new on-chain contract security check  
**Command:** `/add-contract-check`

1. Implement the core check logic in `src/checks/<check>.ts` and/or `src/<check>-core.ts`.
    ```typescript
    // src/admin-power-core.ts
    export function checkAdminPower(contract: Contract): Verdict { ... }
    ```
2. Write unit tests for the check in `src/<check>-core.test.ts` or `src/freeze-core.test.ts`.
    ```typescript
    // src/admin-power-core.test.ts
    import { checkAdminPower } from './admin-power-core';
    test('detects admin powers', () => { ... });
    ```
3. Add a CLI command in `src/commands/<check>.ts`.
    ```typescript
    // src/commands/admin-power.ts
    import { checkAdminPower } from '../admin-power-core';
    export function runAdminPowerCLI(args) { ... }
    ```
4. Register the check in `src/index.ts` and/or the audit suite.
    ```typescript
    // src/index.ts
    export { checkAdminPower } from './admin-power-core';
    ```
5. Update documentation: `README.md`, `CHANGELOG.md`, `docs/IMPROVEMENTS.md`.
6. Optionally, add or update fixtures in `src/fixtures/incidents/*.json` and/or `scripts/capture-fixtures.ts`.

---

### Update Incident Fixtures and Replay Tests
**Trigger:** When a new check is added or logic changes and needs validation against real contracts  
**Command:** `/update-fixtures`

1. Use `scripts/capture-fixtures.ts` to record on-chain reads and responses.
    ```bash
    ts-node scripts/capture-fixtures.ts --check admin-power
    ```
2. Add or update JSON fixtures in `src/fixtures/incidents/*.json`.
3. Update or add tests in `src/incident-fixtures.test.ts` to replay and assert expected verdicts.
    ```typescript
    // src/incident-fixtures.test.ts
    test('replays admin-power incident', () => { ... });
    ```
4. Update `README.md` and `docs/IMPROVEMENTS.md` to reflect new or changed fixtures.

---

### Refactor & Deduplicate Check Logic
**Trigger:** When code duplication is identified across multiple check implementations  
**Command:** `/refactor-checks`

1. Identify duplicated logic across check files (e.g., selector scanning, verdict mapping, role resolution).
2. Extract shared logic into utility files such as `src/lib.ts`, `src/check.ts`, or `src/checks/onchain.ts`.
    ```typescript
    // src/lib.ts
    export function scanSelectors(bytecode: string): string[] { ... }
    ```
3. Update all affected check files to use the shared utilities.
4. Ensure all tests pass and fixtures remain valid.

---

### Documentation and Roadmap Update
**Trigger:** When a new feature is added, a bug is fixed, or research changes the understanding of a feature  
**Command:** `/update-docs`

1. Edit `README.md` to document new features, changes, limitations, or corrections.
2. Update `CHANGELOG.md` with a summary of changes.
3. Update `docs/IMPROVEMENTS.md` to move features from planned to shipped or to clarify plans.
4. Edit `ROADMAP.md` if future plans or priorities change.

---

## Testing Patterns

- Test files use the pattern `*.test.ts` and are placed alongside or near the code they test.
- Testing framework is not explicitly specified, but tests follow standard TypeScript/JavaScript conventions.
- Example test:
    ```typescript
    // src/oracle-hygiene-core.test.ts
    import { checkOracleHygiene } from './oracle-hygiene-core';
    test('flags unsafe oracles', () => {
      const verdict = checkOracleHygiene(mockContract);
      expect(verdict).toBe('unsafe');
    });
    ```

## Commands

| Command              | Purpose                                                      |
|----------------------|--------------------------------------------------------------|
| /add-contract-check  | Add a new on-chain contract security check                   |
| /update-fixtures     | Capture and update incident fixtures and replay tests         |
| /refactor-checks     | Refactor and deduplicate common check logic                  |
| /update-docs         | Update documentation, changelog, and roadmap                 |
```
