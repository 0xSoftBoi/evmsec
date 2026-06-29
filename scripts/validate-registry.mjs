#!/usr/bin/env node
// Validate a bridges.json registry against the schema rules in registry-core.
// Run via tsx (see the `validate:registry` npm script) so the .ts import resolves.
// Exits non-zero on any error so CI can gate a registry PR on it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateRegistry } from "../src/registry-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const path = process.env.EVMSEC_BRIDGES ?? join(here, "..", "bridges.json");

let parsed;
try {
  parsed = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`✗ ${path}: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

const { errors, warnings, routeCount } = validateRegistry(parsed);

for (const w of warnings) console.warn(`⚠ ${w}`);
for (const e of errors) console.error(`✗ ${e}`);

if (errors.length) {
  console.error(`\n✗ ${path}: ${errors.length} error(s) across ${routeCount} route(s).`);
  process.exit(1);
}
console.log(`✓ ${path}: ${routeCount} route(s) valid${warnings.length ? ` (${warnings.length} warning(s))` : ""}.`);
