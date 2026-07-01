#!/usr/bin/env node
/**
 * Regenerate src/data/solc-bugs.ts from the Solidity team's published bug lists.
 *
 *   node scripts/gen-solc-bugs.mjs
 *
 * Pulls the two authoritative files and emits a compact TS module (the long
 * per-bug `description` is dropped — the `link` points at the full writeup).
 */
import { writeFileSync, mkdirSync } from "node:fs";

const BUGS_URL = "https://raw.githubusercontent.com/ethereum/solidity/develop/docs/bugs.json";
const BY_VERSION_URL = "https://raw.githubusercontent.com/ethereum/solidity/develop/docs/bugs_by_version.json";

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.json();
}

const [bugs, bbv] = await Promise.all([getJson(BUGS_URL), getJson(BY_VERSION_URL)]);

const meta = {};
for (const b of bugs) {
  meta[b.name] = {
    uid: b.uid,
    summary: b.summary,
    severity: b.severity,
    ...(b.link ? { link: b.link } : {}),
    ...(b.introduced ? { introduced: b.introduced } : {}),
    ...(b.fixed ? { fixed: b.fixed } : {}),
    ...(b.conditions && Object.keys(b.conditions).length ? { conditions: b.conditions } : {}),
  };
}
const byVersion = {};
for (const [v, o] of Object.entries(bbv)) byVersion[v] = o.bugs || [];

const header = `/**
 * Bundled solc compiler-bug data — DERIVED, do not edit by hand.
 *
 * Source of truth: the Solidity team's own published lists,
 *   - ${BUGS_URL}
 *   - ${BY_VERSION_URL}
 * Regenerate with scripts/gen-solc-bugs.mjs. The long per-bug \`description\` is
 * dropped to keep the bundle small; the \`link\` points at the full writeup.
 */

export interface SolcBug {
  uid: string;
  summary: string;
  severity: string;
  /** link to the official writeup; absent for some older bugs. */
  link?: string;
  introduced?: string;
  fixed?: string;
  /** the bug only bites under these compile settings (viaIR, optimizer, evmVersion, …). */
  conditions?: Record<string, unknown>;
}

`;

const out =
  header +
  "export const SOLC_BUGS: Record<string, SolcBug> = " +
  JSON.stringify(meta, null, 2) +
  ";\n\n" +
  "/** exact solc version → names of bugs present in that release. */\n" +
  "export const SOLC_BUGS_BY_VERSION: Record<string, string[]> = " +
  JSON.stringify(byVersion) +
  ";\n";

mkdirSync("src/data", { recursive: true });
writeFileSync("src/data/solc-bugs.ts", out);
console.log(`wrote src/data/solc-bugs.ts (${Object.keys(meta).length} bugs, ${Object.keys(byVersion).length} versions)`);
