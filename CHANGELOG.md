# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Tooling**: ESLint (flat config, type-aware) and Prettier, wired into a
  single `npm run check` gate (format → lint → typecheck → test).
- **Build/packaging**: a real compiled build (`tsc` → `dist/`); the published
  `bin` now runs on plain Node without `tsx`. `prepublishOnly` rebuilds before
  publish.
- **CI**: least-privilege `permissions`, run-cancelling `concurrency`, and a
  dedicated quality job (lint, format, typecheck, build) alongside the Node
  20/22 test matrix.
- **Project governance**: `SECURITY.md`, `CODE_OF_CONDUCT.md`, this changelog,
  `.editorconfig`, Dependabot config, and GitHub issue/PR templates (including a
  structured bridge-route submission form).

### Changed

- `tsx` moved from runtime `dependencies` to `devDependencies` — it is only
  needed for development now that the package ships compiled JavaScript.

### Fixed

- **Test discovery on Node 20**: the previous `tsx --test src/**/*.test.ts`
  relied on glob expansion that neither POSIX `sh` nor the Node 20 test runner
  performs, so the Node 20 CI leg discovered no test files. Discovery is now
  done explicitly in `scripts/run-tests.mjs` and behaves identically across
  shells and Node 20/22.

## [0.1.0]

Initial release.

### Added

- `solvency` — lock-and-mint bridge backing check (`balanceOf(escrow) ≥
totalSupply(wrapped)`), with `--all`, ad-hoc routes, `--json`, and a
  non-zero exit on undercollateralization.
- `solvency --since` — forensic binary search for the block where backing first
  broke, aligning the source chain to each destination block by timestamp.
- `upgradeability` — EIP-1967 / legacy zeppelinos proxy and upgrade-admin risk
  check.
- `settlement` — ERC-7683 cross-chain intent fill verification.
- `pq-readiness` — post-quantum readiness classification of a verifier from its
  deployed bytecode.
- Unit-tested pure logic (backing math, forensic bisection, proxy-slot parsing,
  PQ classification, settlement matching) running with no network.

[unreleased]: https://github.com/0xSoftBoi/evmsec/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/0xSoftBoi/evmsec/releases/tag/v0.1.0
