#!/usr/bin/env node
import { access, readdir, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const documentationRoots = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs",
  "integrations",
];
const sourceRoots = [
  ".env.example",
  "config",
  "compose.yaml",
  "integrations",
  "scripts",
  "src",
  "systemd",
];

const documentationFiles = await collectMarkdownFiles(documentationRoots);
const knownVariables = await collectKnownVariables(sourceRoots);
const failures = [];

for (const file of documentationFiles) {
  const content = await readFile(file, "utf8");
  await checkRelativeLinks(file, content);
  checkEnvironmentVariables(file, content);
}

if (failures.length > 0) {
  console.error("Documentation checks failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `Documentation checks passed (${documentationFiles.length} Markdown files).`,
  );
}

async function collectMarkdownFiles(entries) {
  const files = [];
  for (const entry of entries) {
    const path = resolve(root, entry);
    const info = await stat(path);
    if (info.isDirectory()) files.push(...(await walk(path)));
    else if (path.endsWith(".md")) files.push(path);
  }
  return files;
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

async function collectKnownVariables(entries) {
  const variables = new Set();
  for (const entry of entries) {
    const path = resolve(root, entry);
    const info = await stat(path);
    const files = info.isDirectory() ? await walkAll(path) : [path];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const match of content.matchAll(/\bAGENT_MEMORY_[A-Z0-9_]+\b/g))
        variables.add(match[0]);
    }
  }
  return variables;
}

async function walkAll(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkAll(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function checkRelativeLinks(file, content) {
  for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, "").split(/\s+/, 1)[0];
    if (
      !target ||
      target.startsWith("#") ||
      /^[a-z][a-z0-9+.-]*:/i.test(target)
    )
      continue;
    const pathname = target.split("#", 1)[0];
    if (!pathname) continue;
    const resolved = resolve(dirname(file), pathname);
    if (relative(root, resolved).startsWith("..")) {
      failures.push(`${display(file)} links outside the repository: ${target}`);
      continue;
    }
    try {
      await access(resolved, constants.F_OK);
    } catch {
      failures.push(`${display(file)} has a missing relative link: ${target}`);
    }
  }
}

function checkEnvironmentVariables(file, content) {
  for (const match of new Set(
    content.match(/\bAGENT_MEMORY_[A-Z0-9_]+\b/g) ?? [],
  )) {
    if (!knownVariables.has(match))
      failures.push(
        `${display(file)} references an unknown environment variable: ${match}`,
      );
  }
}

function display(path) {
  return relative(root, path);
}
