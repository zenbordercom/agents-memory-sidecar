#!/usr/bin/env node
import { readFileSync } from "node:fs";

const args = parseArgs(process.argv.slice(2));
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const version = args.version ?? packageJson.version;
const tag = args.tag ?? process.env.GITHUB_REF_NAME;
const changelog = readFileSync("CHANGELOG.md", "utf8");

if (version !== packageJson.version) {
  throw new Error(`Release version ${version} does not match package.json version ${packageJson.version}`);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid semver release version: ${version}`);
}
if (!changelog.includes(`## ${version} -`)) {
  throw new Error(`CHANGELOG.md is missing a dated heading for version ${version}`);
}
if (tag && tag !== `v${version}`) {
  throw new Error(`Release tag ${tag} does not match expected v${version}`);
}

console.log(JSON.stringify({ name: packageJson.name, version, tag: tag ?? null, verified: true }));

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
    const key = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}
