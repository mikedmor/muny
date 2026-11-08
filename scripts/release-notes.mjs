#!/usr/bin/env node
/**
 * Print the CHANGELOG.md section for a version, after checking it matches
 * package.json. The release workflow uses it for the GitHub release notes.
 *
 *   node scripts/release-notes.mjs v1.0.0
 */
import { readFileSync } from "node:fs";

const tag = process.argv[2] ?? "";
const version = tag.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error(`Not a version tag: "${tag}" (expected something like v1.0.0)`);
  process.exit(1);
}
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (pkg.version !== version) {
  console.error(
    `The tag is ${version} but package.json says ${pkg.version}. Run: pnpm version:set ${version}`,
  );
  process.exit(1);
}
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const start = changelog.search(new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m"));
if (start < 0) {
  console.error(`CHANGELOG.md has no "## [${version}]" section.`);
  process.exit(1);
}
const rest = changelog.slice(start);
const next = rest.slice(3).search(/^## \[/m);
const section = (next < 0 ? rest : rest.slice(0, next + 3))
  .split("\n")
  .slice(1)
  // Link definitions at the end of the file belong to the whole changelog.
  .filter((l) => !/^\[[^\]]+\]: /.test(l))
  .join("\n")
  .trim();
process.stdout.write(`${section}\n`);
