#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sourceDir = resolve(process.argv[2] ?? process.cwd());
const tempDir = await mkdtemp(join(tmpdir(), "agents-memory-package-"));

try {
  const packed = JSON.parse(
    execFileSync("npm", ["pack", sourceDir, "--json"], {
      cwd: tempDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const tarball = join(tempDir, packed[0].filename);
  const expected = new Set([
    "dist/cli.js",
    "dist/server.js",
    "dist/http-server.js",
    "dist/search-benchmark.js",
    "fixtures/search-relevance.v1.json",
    "migrations/001_initial.sql",
    "README.md",
    "LICENSE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
  ]);
  const files = new Set(packed[0].files.map((entry) => entry.path));
  const missing = [...expected].filter((path) => !files.has(path));
  if (missing.length)
    throw new Error(`Tarball missing required files: ${missing.join(", ")}`);

  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    {
      cwd: tempDir,
      stdio: "inherit",
    },
  );
  const binDir = join(tempDir, "node_modules", ".bin");
  const bins = ["agents-memory", "agents-memory-mcp", "agents-memory-http"];
  const installed = new Set(await readdir(binDir));
  const absentBins = bins.filter((bin) => !installed.has(bin));
  if (absentBins.length)
    throw new Error(
      `Clean install is missing CLI entries: ${absentBins.join(", ")}`,
    );

  execFileSync(join(binDir, "agents-memory"), ["--help"], {
    cwd: tempDir,
    stdio: ["ignore", "pipe", "inherit"],
  });
  console.log(
    JSON.stringify({
      tarball: packed[0].filename,
      files: files.size,
      bins,
      verified: true,
    }),
  );
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
