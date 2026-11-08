#!/usr/bin/env node
/**
 * Set the version in every package.json of the workspace (they move together).
 *
 *   pnpm version:set 1.1.0
 *
 * Then add a "## [1.1.0] - YYYY-MM-DD" section to CHANGELOG.md, commit, and
 * push a v1.1.0 tag to publish it.
 */
import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: pnpm version:set <major.minor.patch>");
  process.exit(1);
}
const files = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/core/package.json",
  "packages/db/package.json",
  "packages/shared/package.json",
];
for (const f of files) {
  const url = new URL(`../${f}`, import.meta.url);
  const text = readFileSync(url, "utf8");
  const next = text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) {
    console.error(`No version field in ${f}`);
    process.exit(1);
  }
  writeFileSync(url, next);
  console.log(`${f} → ${version}`);
}
