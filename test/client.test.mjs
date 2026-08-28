import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requestSigned, verifyBundle } from "../src/client.mjs";
import { installBundle } from "../src/installer.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
function response(payload, privateKey = keys.privateKey) {
  return new Response(JSON.stringify({ $schema: "flowstack.signed-envelope.v1", payload, signature: { algorithm: "Ed25519", keyId: "test", value: sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString("base64") } }), { status: 200, headers: { "content-type": "application/json" } });
}
function bundle(content = "export const value = 1;\n") {
  const bytes = Buffer.from(content); const files = [{ path: "block.tsx", bytes: bytes.length, sha256: sha256(bytes), content: bytes.toString("base64") }];
  const identity = JSON.stringify({ id: "application/example/simple", version: "2026.08.1", files: files.map(({ path, bytes: size, sha256: digest }) => ({ path, bytes: size, sha256: digest })) });
  return { $schema: "flowstack.block-bundle.v1", version: "2026.08.1", item: { id: "application/example/simple" }, files, bundleSha256: sha256(identity) };
}

test("sends bearer auth without logging it and verifies the pinned signature", async () => {
  let request;
  const payload = { $schema: "flowstack.block-catalog.v1", items: [] };
  const result = await requestSigned("/v1/catalog", { registryUrl: "https://registry.example", token: "secret-token", publicKey }, async (url, options) => { request = { url, options }; return response(payload); });
  assert.deepEqual(result, payload);
  assert.equal(request.options.headers.authorization, "Bearer secret-token");
  const wrong = generateKeyPairSync("ed25519");
  await assert.rejects(() => requestSigned("/v1/catalog", { registryUrl: "https://registry.example", token: "secret-token", publicKey }, async () => response(payload, wrong.privateKey)), /signature verification failed/u);
});

test("rejects corrupt bundles before filesystem mutation", async () => {
  const value = bundle(); value.files[0].content = Buffer.from("tampered").toString("base64");
  assert.throws(() => verifyBundle(value), /integrity failed/u);
});

test("dry-run reports collisions; normal install refuses; force is transactional and preserves unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowstack-blocks-cli-test-"));
  try {
    const payload = bundle(); const files = verifyBundle(payload); const target = "components/blocks/example-simple"; const targetRoot = join(root, target);
    await mkdir(targetRoot, { recursive: true });
    await writeFile(join(targetRoot, "block.tsx"), "consumer edit\n"); await writeFile(join(targetRoot, "notes.md"), "preserve\n");
    const plan = await installBundle({ payload, files, project: root, target, dryRun: true });
    assert.deepEqual(plan.collisions, ["block.tsx"]); assert.equal(await readFile(join(targetRoot, "block.tsx"), "utf8"), "consumer edit\n");
    await assert.rejects(() => installBundle({ payload, files, project: root, target }), /would overwrite/u);
    await installBundle({ payload, files, project: root, target, force: true });
    assert.equal(await readFile(join(targetRoot, "block.tsx"), "utf8"), "export const value = 1;\n");
    assert.equal(await readFile(join(targetRoot, "notes.md"), "utf8"), "preserve\n");
    const provenance = JSON.parse(await readFile(join(targetRoot, ".flowstack-block.json"), "utf8"));
    assert.equal(provenance.bundleSha256, payload.bundleSha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});
