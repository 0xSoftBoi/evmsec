# Security Policy

`evmsec` is a security tool, so we hold its own security to a high bar — and we
care about two distinct things: vulnerabilities in this code, and the accuracy
of the answers it gives about on-chain systems.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's
[private vulnerability reporting](https://github.com/0xSoftBoi/evmsec/security/advisories/new)
("Report a vulnerability" under the repository's **Security** tab). If that is
unavailable, contact the maintainer listed in `package.json`.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal command line or input is ideal),
- the version / commit you tested, and
- any suggested remediation.

We aim to acknowledge a report within **72 hours** and to agree on a disclosure
timeline with you. We support coordinated disclosure and will credit reporters
who want it.

## Scope

In scope:

- the CLI and library code in `src/`,
- the build/release pipeline and CI configuration,
- the bundled `bridges.json` registry **only** for correctness of cited
  addresses (a wrong escrow makes the tool lie — see below).

Out of scope:

- vulnerabilities in third-party RPC providers or upstream dependencies (report
  those upstream; we will bump once a fix is released),
- denial of service caused by pointing the tool at an unreliable or malicious
  RPC endpoint.

## A note on result integrity

`evmsec` answers questions like "is this bridge fully backed?" and "is this
verifier quantum-vulnerable?" **A security tool fed the wrong addresses lies
confidently.** Two consequences:

1. The bundled `bridges.json` entries are _illustrative_. Every address must be
   verified against the bridge's own primary source before a result is trusted.
   A mis-attributed address in the registry is treated as a security-relevant
   bug — report it.
2. The `pq-readiness` and `upgradeability` checks are heuristics over deployed
   bytecode / storage slots, honestly scoped in the README. They are decision
   _inputs_, not proofs. If you find a case where the tool asserts a positive
   safety claim it cannot support, that is a bug we want to hear about.

## Supported versions

The project is pre-1.0. Security fixes are applied to the latest release and the
`master` branch. Pin a commit or released version in production and watch
releases for advisories.
