import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const temporary = await mkdtemp(join(tmpdir(), "flowstack-blocks-cli-pack-"));
try {
  const result = JSON.parse(execFileSync("npm", ["pack", "--json", "--silent", "--pack-destination", temporary], { cwd: root, encoding: "utf8", env: { ...process.env, npm_config_cache: join(temporary, "npm-cache") } }));
  assert.equal(result.length, 1);
  const listing = execFileSync("tar", ["-tzf", join(temporary, result[0].filename)], { encoding: "utf8" }).trim().split("\n");
  assert.ok(listing.includes("package/bin/flowstack-blocks.mjs"));
  assert.ok(listing.includes("package/src/client.mjs"));
  assert.equal(listing.some((path) => /package\/(?:registry|bundles|agents|test|\.github)(?:\/|$)/u.test(path)), false);
  assert.equal(listing.some((path) => /\.(?:tsx?|jsx?|css|webp|png|svg)$/u.test(path)), false);
  console.log(`Verified source-free archive ${result[0].filename}.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
