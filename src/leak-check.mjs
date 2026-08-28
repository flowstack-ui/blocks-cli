import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const forbiddenPaths = /(?:^|\/)(?:registry|blocks|bundles|previews|agents)(?:\/|$)|\.(?:tsx?|jsx?|css|webp|png|svg)$/u;
const forbiddenContent = /flowstack\.block-(?:registry|agent)\.v1|application\/feed\/threaded-comments|identity-access\/sign-in\/simple/u;
async function walk(path) {
  const found = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    if (entry.isDirectory()) found.push(...await walk(child)); else found.push(child);
  }
  return found;
}
for (const path of await walk(root)) {
  const name = relative(root, path).split("\\").join("/");
  assert.doesNotMatch(name, forbiddenPaths, `public CLI path resembles premium source: ${name}`);
  if (!/package-lock\.json$/u.test(name)) assert.doesNotMatch(await readFile(path, "utf8").catch(() => ""), forbiddenContent, `public CLI content names premium source: ${name}`);
}
console.log("Verified public CLI contains no catalog, Block source, item Agent Knowledge, or preview artifacts.");
