import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
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

function componentBundle(content = "export const RichTextEditor = () => null;\n", dependencies = { "@flowstack-ui/brick": "0.1.12" }) {
  const bytes = Buffer.from(content);
  const files = [{ path: "rich-text-editor.tsx", bytes: bytes.length, sha256: sha256(bytes), content: bytes.toString("base64") }];
  const sourceIdentity = files.map(({ path, sha256: digest }) => ({ path, sha256: digest })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const item = {
    id: "components/rich-text-editor/basic",
    name: "Rich Text Editor / Basic",
    description: "A source-installed editor.",
    access: "paid",
    artifactType: "component",
    family: "components",
    category: "Typography",
    variant: "basic",
    destination: "components/ui/rich-text-editor",
    sourceIntegritySha256: sha256(JSON.stringify(sourceIdentity)),
    dependencies: { packages: dependencies },
    agentCoverage: { status: "declared", json: "agent.json", markdown: "agent.md" },
    preview: { id: "rich-text-editor-basic", type: "compiled", url: "/components/rich-text-editor/basic", alt: "Basic rich text editor", width: 960, height: 640 },
  };
  const identity = JSON.stringify({ itemId: item.id, artifactType: "component", version: "2026.08.2", files: files.map(({ path, bytes: size, sha256: digest }) => ({ path, bytes: size, sha256: digest })) });
  return { $schema: "flowstack.source-bundle.v1", itemId: item.id, artifactType: "component", version: "2026.08.2", item, files, bundleSha256: sha256(identity) };
}

async function writeInstalledPackage(root, name, version) {
  const directory = join(root, "node_modules", ...name.split("/"));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ name, version })}\n`);
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

test("rejects missing or unsupported source-component dependency contracts before installation", () => {
  assert.throws(() => verifyBundle(componentBundle(undefined, {})), /must declare at least one package dependency/u);
  const extraDependencyMetadata = componentBundle();
  extraDependencyMetadata.item.dependencies.privateRegistry = "never public";
  assert.throws(() => verifyBundle(extraDependencyMetadata), /must declare at least one package dependency/u);
  assert.throws(() => verifyBundle(componentBundle(undefined, { "@flowstack-ui/brick": "^0.1.12" })), /unsupported dependency range/u);
  assert.throws(() => verifyBundle(componentBundle(undefined, { "../private-package": "1.0.0" })), /invalid package name/u);
  assert.doesNotThrow(() => verifyBundle(componentBundle(undefined, { react: ">=18.3 <20" })));
});

test("recomputes source-component aggregate integrity from canonical delivered paths", () => {
  const records = [
    { path: "z-last.ts", content: Buffer.from("export const last = true;\n") },
    { path: "a-first.ts", content: Buffer.from("export const first = true;\n") },
  ].map(({ path, content }) => ({ path, bytes: content.length, sha256: sha256(content), content: content.toString("base64") }));
  const item = {
    id: "components/example/basic",
    artifactType: "component",
    dependencies: { packages: { react: ">=18.3.0 <20.0.0" } },
    sourceIntegritySha256: sha256(JSON.stringify(records
      .map(({ path, sha256: digest }) => ({ path, sha256: digest }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0))),
  };
  const identity = JSON.stringify({
    itemId: item.id,
    artifactType: "component",
    version: "2026.08.2",
    files: records.map(({ path, bytes, sha256: digest }) => ({ path, bytes, sha256: digest })),
  });
  const payload = { $schema: "flowstack.source-bundle.v1", itemId: item.id, artifactType: "component", version: "2026.08.2", item, files: records, bundleSha256: sha256(identity) };
  assert.equal(verifyBundle(payload).length, 2);
  payload.item.sourceIntegritySha256 = "0".repeat(64);
  assert.throws(() => verifyBundle(payload), /source integrity verification failed/u);
});

test("binds requested identity and every public signed metadata field to the delivered bundle", () => {
  const payload = componentBundle();
  const requestedId = payload.item.id;
  assert.doesNotThrow(() => verifyBundle(payload, { expectedItem: structuredClone(payload.item), requestedId }));
  const mismatches = [
    (item) => { item.name = "Surrogate component"; },
    (item) => { item.description = "Different signed description."; },
    (item) => { item.access = "free"; },
    (item) => { item.category = "Application"; },
    (item) => { item.variant = "surrogate"; },
    (item) => { item.destination = "components/ui/surrogate"; },
    (item) => { item.dependencies.packages["@flowstack-ui/brick"] = "0.1.11"; },
    (item) => { item.sourceIntegritySha256 = "f".repeat(64); },
    (item) => { item.agentCoverage.status = "missing"; },
    (item) => { item.preview.url = "/components/surrogate/basic"; },
    (item) => { item.artifactType = "block"; },
  ];
  for (const mutate of mismatches) {
    const metadata = structuredClone(payload.item);
    mutate(metadata);
    assert.throws(() => verifyBundle(payload, { expectedItem: metadata, requestedId }), /does not match the requested signed catalog metadata/u);
  }
  assert.throws(() => verifyBundle(payload, { expectedItem: payload.item, requestedId: "components/surrogate/basic" }), /does not match the requested signed catalog metadata/u);
});

test("rejects closed-set artifact-type violations in verification and installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowstack-invalid-artifact-test-"));
  try {
    const valid = componentBundle();
    const files = verifyBundle(valid);
    const invalid = structuredClone(valid);
    invalid.item.artifactType = "other";
    invalid.artifactType = "other";
    assert.throws(() => verifyBundle(invalid), /Unsupported source artifact type/u);
    await assert.rejects(() => installBundle({ payload: invalid, files, project: root }), /Unsupported source artifact type/u);
    const inconsistent = structuredClone(valid);
    inconsistent.itemId = "components/surrogate/basic";
    assert.throws(() => verifyBundle(inconsistent), /item identity is inconsistent/u);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
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

test("verifies and installs source components to their component destination with a distinct receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowstack-component-cli-test-"));
  try {
    const payload = componentBundle();
    const files = verifyBundle(payload);
    const plan = await installBundle({ payload, files, project: root });
    assert.equal(plan.target, "components/ui/rich-text-editor");
    assert.equal(await readFile(join(root, plan.target, "rich-text-editor.tsx"), "utf8"), "export const RichTextEditor = () => null;\n");
    const receipt = JSON.parse(await readFile(join(root, plan.target, ".flowstack-component.json"), "utf8"));
    assert.equal(receipt.$schema, "flowstack.source-install.v1");
    assert.equal(receipt.artifactType, "component");
    assert.equal(receipt.itemId, payload.item.id);
    assert.equal(receipt.sourceIntegritySha256, payload.item.sourceIntegritySha256);
    assert.deepEqual(receipt.dependencies, { "@flowstack-ui/brick": "0.1.12" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source-component dry-run reports compatible and missing dependencies with collisions without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowstack-component-preflight-test-"));
  try {
    await writeInstalledPackage(root, "@flowstack-ui/brick", "0.1.12");
    await writeInstalledPackage(root, "react", "19.1.0");
    const payload = componentBundle(undefined, {
      "@flowstack-ui/brick": "0.1.12",
      "@tiptap/react": ">=3.30.5 <4.0.0",
      react: ">=18.3.0 <20.0.0",
    });
    const files = verifyBundle(payload);
    const target = join(root, payload.item.destination);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "rich-text-editor.tsx"), "consumer edit\n");

    const plan = await installBundle({ payload, files, project: root, dryRun: true });
    assert.deepEqual(plan.dependencies, [
      { name: "@flowstack-ui/brick", range: "0.1.12", version: "0.1.12", status: "compatible" },
      { name: "@tiptap/react", range: ">=3.30.5 <4.0.0", version: null, status: "missing" },
      { name: "react", range: ">=18.3.0 <20.0.0", version: "19.1.0", status: "compatible" },
    ]);
    assert.deepEqual(plan.collisions, ["rich-text-editor.tsx"]);
    assert.equal(await readFile(join(target, "rich-text-editor.tsx"), "utf8"), "consumer edit\n");
    await assert.rejects(readFile(join(target, ".flowstack-component.json"), "utf8"), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source-component incompatible dependencies block dry-run and installation before any write", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowstack-component-incompatible-test-"));
  try {
    await writeInstalledPackage(root, "@flowstack-ui/brick", "0.1.11");
    const payload = componentBundle();
    const files = verifyBundle(payload);
    const target = join(root, payload.item.destination);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "rich-text-editor.tsx"), "consumer edit\n");

    await assert.rejects(() => installBundle({ payload, files, project: root, dryRun: true }), /@flowstack-ui\/brick@0\.1\.11 does not satisfy 0\.1\.12/u);
    await assert.rejects(() => installBundle({ payload, files, project: root, force: true }), /@flowstack-ui\/brick@0\.1\.11 does not satisfy 0\.1\.12/u);
    assert.equal(await readFile(join(target, "rich-text-editor.tsx"), "utf8"), "consumer edit\n");
    await assert.rejects(readFile(join(target, ".flowstack-component.json"), "utf8"), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("component add dry-run prints dependency statuses and the exact missing install specification", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowstack-component-cli-output-test-"));
  const output = [];
  const originalLog = console.log;
  try {
    await writeInstalledPackage(root, "@flowstack-ui/brick", "0.1.12");
    const payload = componentBundle(undefined, {
      "@flowstack-ui/brick": "0.1.12",
      "@tiptap/react": ">=3.30.5 <4.0.0",
    });
    console.log = (...values) => output.push(values.join(" "));
    await run(["add", payload.item.id, "--project", root, "--dry-run"], {
      loadConfig: async () => ({ token: "test-token" }),
      requestSigned: async (path) => path.startsWith("/v1/bundles/") ? payload : { item: payload.item },
    });
    assert.match(output.join("\n"), /Dependency: @flowstack-ui\/brick@0\.1\.12 \(compatible; requires 0\.1\.12\)/u);
    assert.match(output.join("\n"), /Dependency: @tiptap\/react@missing \(missing; requires >=3\.30\.5 <4\.0\.0\)/u);
    assert.match(output.join("\n"), /Install required packages: @tiptap\/react@">=3\.30\.5 <4\.0\.0"/u);
    await assert.rejects(readFile(join(root, payload.item.destination, "rich-text-editor.tsx"), "utf8"), { code: "ENOENT" });
  } finally {
    console.log = originalLog;
    await rm(root, { recursive: true, force: true });
  }
});

test("component add rejects a signed Block-bundle downgrade before dry-run or installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowstack-component-downgrade-test-"));
  try {
    const component = componentBundle();
    const downgraded = bundle();
    downgraded.item = { ...structuredClone(component.item), artifactType: "block" };
    const identity = JSON.stringify({
      id: downgraded.item.id,
      version: downgraded.version,
      files: downgraded.files.map(({ path, bytes, sha256: digest }) => ({ path, bytes, sha256: digest })),
    });
    downgraded.bundleSha256 = sha256(identity);
    await assert.rejects(() => run(["add", component.item.id, "--project", root, "--dry-run"], {
      loadConfig: async () => ({ token: "test-token" }),
      requestSigned: async (path) => path.startsWith("/v1/bundles/") ? downgraded : { item: component.item },
    }), /does not match the requested signed catalog metadata/u);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("forced installation rejects declared-file and ancestor symlinks without outside writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowstack-symlink-project-test-"));
  const outside = await mkdtemp(join(tmpdir(), "flowstack-symlink-outside-test-"));
  try {
    const payload = bundle();
    const files = verifyBundle(payload);
    const target = "components/blocks/example-simple";
    const targetRoot = join(root, target);
    const outsideFile = join(outside, "outside.txt");
    await mkdir(targetRoot, { recursive: true });
    await writeFile(outsideFile, "outside remains\n");
    await symlink(outsideFile, join(targetRoot, "block.tsx"));

    await assert.rejects(() => installBundle({ payload, files, project: root, target, force: true }), /symbolic link/u);
    assert.equal(await readFile(outsideFile, "utf8"), "outside remains\n");
    await assert.rejects(readFile(join(targetRoot, ".flowstack-block.json"), "utf8"), { code: "ENOENT" });
    assert.equal((await readdir(join(root, "components", "blocks"))).some((name) => name.includes(".flowstack-")), false);

    await rm(join(root, "components"), { recursive: true, force: true });
    await mkdir(join(root, "components"), { recursive: true });
    await symlink(outside, join(root, "components", "blocks"));
    await assert.rejects(() => installBundle({ payload, files, project: root, target, force: true }), /symbolic link/u);
    assert.equal(await readFile(outsideFile, "utf8"), "outside remains\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("legacy Block bundles retain dependency-agnostic install behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowstack-block-legacy-dependencies-test-"));
  try {
    const payload = bundle();
    payload.item.dependencies = { packages: { "../legacy-private-package": "not-a-semver-range" } };
    const files = verifyBundle(payload);
    const plan = await installBundle({ payload, files, project: root, dryRun: true });
    assert.deepEqual(plan.dependencies, []);
    await installBundle({ payload, files, project: root });
    assert.equal(await readFile(join(root, "components/blocks/example-simple/block.tsx"), "utf8"), "export const value = 1;\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
