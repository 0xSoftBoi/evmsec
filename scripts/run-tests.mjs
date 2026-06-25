#!/usr/bin/env node
// Cross-version, cross-shell test discovery.
//
// `tsx --test src/**/*.test.ts` relies on glob expansion: POSIX `sh` does not
// expand `**`, and Node's test runner only learned to expand globs in v21 — so
// on the Node 20 CI leg the pattern matches nothing and tests silently pass.
// Discover the files ourselves (fs.readdirSync recursive is stable since Node 18)
// and hand explicit paths to tsx so it behaves identically everywhere.
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, sep } from "node:path";

const SRC = "src";

const testFiles = readdirSync(SRC, { recursive: true })
  .map((entry) => String(entry))
  .filter((entry) => entry.endsWith(".test.ts"))
  .map((entry) => join(SRC, entry).split(sep).join("/"))
  .sort();

if (testFiles.length === 0) {
  console.error(`no *.test.ts files found under ${SRC}/`);
  process.exit(1);
}

const extraArgs = process.argv.slice(2);
// On Windows the binary is tsx.cmd; `shell: true` resolves either from PATH
// (npm puts node_modules/.bin on PATH when running scripts).
const child = spawn("tsx", ["--test", ...extraArgs, ...testFiles], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
