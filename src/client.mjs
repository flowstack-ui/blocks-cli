import { verify, createPublicKey, createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { assertArtifactType, sourceDependencyContract } from "./dependencies.mjs";

const schema = "flowstack.signed-envelope.v1";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function fail(message) { throw new Error(message); }

export function registryConfigPath(env = process.env) {
  return resolve(env.FLOWSTACK_BLOCKS_CONFIG ?? `${homedir()}/.config/flowstack/blocks.json`);
}

export async function loadConfig(env = process.env) {
  const path = registryConfigPath(env);
  let stored = {};
  try {
    const details = await stat(path);
    if ((details.mode & 0o077) !== 0) fail(`Refusing insecure credentials file ${path}; set permissions to 0600.`);
    stored = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const token = env.FLOWSTACK_BLOCKS_TOKEN ?? stored.token;
  const registryUrl = env.FLOWSTACK_BLOCKS_REGISTRY_URL ?? stored.registryUrl;
  const publicKey = env.FLOWSTACK_BLOCKS_PUBLIC_KEY ?? stored.publicKey;
  if (!registryUrl) fail("No registry URL. Set FLOWSTACK_BLOCKS_REGISTRY_URL or configure registryUrl.");
  const url = new URL(registryUrl);
  if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) fail("The Blocks registry must use HTTPS outside local development.");
  if (!publicKey) fail("No trusted registry signing key. Set FLOWSTACK_BLOCKS_PUBLIC_KEY or configure publicKey.");
  return { token, registryUrl: url.href.replace(/\/$/u, ""), publicKey };
}

export function requireAccessToken(config) {
  if (!config.token) fail("This paid Block requires an access token. Set FLOWSTACK_BLOCKS_TOKEN or use a mode-0600 config file.");
  return config;
}

export async function requestSigned(path, config, fetchImpl = fetch) {
  const headers = { accept: "application/json" };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  const response = await fetchImpl(`${config.registryUrl}${path}`, {
    headers,
    redirect: "error",
  });
  let envelope;
  try { envelope = await response.json(); } catch { fail(`Registry returned an invalid response (${response.status}).`); }
  if (!response.ok) fail(envelope?.error?.message ?? `Registry request failed (${response.status}).`);
  if (envelope?.$schema !== schema || !envelope.payload || typeof envelope.signature?.value !== "string") fail("Registry response is not a signed FLOWSTACK envelope.");
  const bytes = Buffer.from(JSON.stringify(envelope.payload));
  let trusted;
  try { trusted = createPublicKey(config.publicKey); } catch { fail("The configured registry signing key is invalid."); }
  if (!verify(null, bytes, trusted, Buffer.from(envelope.signature.value, "base64"))) fail("Registry signature verification failed; no files were written.");
  return envelope.payload;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, canonicalJson(child)]));
  }
  return value;
}

function publicItemIdentity(item) {
  const result = Object.fromEntries([
    "id", "artifactType", "name", "description", "access", "family", "category", "variant",
    "destination", "sourceIntegritySha256",
  ].filter((key) => item?.[key] !== undefined).map((key) => [key, item[key]]));
  result.artifactType = assertArtifactType(item?.artifactType);
  if (item?.dependencies?.packages) result.dependencies = { packages: { ...item.dependencies.packages } };
  if (item?.agentCoverage?.status) result.agentCoverage = { status: item.agentCoverage.status };
  if (item?.preview === null) result.preview = null;
  else if (item?.preview) {
    result.preview = Object.fromEntries(["id", "type", "url", "alt", "width", "height"]
      .filter((key) => item.preview[key] !== undefined).map((key) => [key, item.preview[key]]));
  }
  return canonicalJson(result);
}

function verifyMetadataBinding(payload, expectedItem, requestedId) {
  if (!expectedItem && !requestedId) return;
  if (!expectedItem || typeof requestedId !== "string" || requestedId.length === 0) fail("Registry bundle metadata binding is incomplete.");
  const expected = publicItemIdentity(expectedItem);
  const delivered = publicItemIdentity(payload?.item);
  if (expected.id !== requestedId || delivered.id !== requestedId || JSON.stringify(expected) !== JSON.stringify(delivered)) {
    fail("Registry bundle does not match the requested signed catalog metadata; no files were written.");
  }
}

export function verifyBundle(payload, { expectedItem, requestedId } = {}) {
  const artifactType = assertArtifactType(payload?.item?.artifactType ?? payload?.artifactType);
  if (payload?.artifactType !== undefined && assertArtifactType(payload.artifactType) !== artifactType) fail("Registry bundle artifact type is inconsistent.");
  const expectedSchema = artifactType === "block" ? "flowstack.block-bundle.v1" : "flowstack.source-bundle.v1";
  if (payload?.$schema !== expectedSchema || !payload.item?.id || !Array.isArray(payload.files)) fail("Registry bundle is invalid.");
  if (artifactType === "component" && payload.itemId !== payload.item.id) fail("Registry bundle item identity is inconsistent.");
  verifyMetadataBinding(payload, expectedItem, requestedId);
  sourceDependencyContract(payload.item, artifactType);
  const seen = new Set();
  for (const file of payload.files) {
    if (!file.path || file.path.startsWith("/") || file.path.includes("..") || seen.has(file.path)) fail("Registry bundle contains an unsafe or duplicate file path.");
    seen.add(file.path);
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) fail(`Registry bundle integrity failed for ${file.path}.`);
  }
  const fileIdentity = payload.files.map(({ path, bytes, sha256: digest }) => ({ path, bytes, sha256: digest }));
  if (artifactType === "component") {
    const sourceIdentity = fileIdentity
      .map(({ path, sha256: digest }) => ({ path, sha256: digest }))
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    if (!/^[a-f0-9]{64}$/u.test(payload.item.sourceIntegritySha256 ?? "") || sha256(JSON.stringify(sourceIdentity)) !== payload.item.sourceIntegritySha256) {
      fail("Registry bundle source integrity verification failed.");
    }
  }
  const identity = JSON.stringify(artifactType === "block"
    ? { id: payload.item.id, version: payload.version, files: fileIdentity }
    : { itemId: payload.item.id, artifactType, version: payload.version, files: fileIdentity });
  if (sha256(identity) !== payload.bundleSha256) fail("Registry bundle identity verification failed.");
  return payload.files.map((file) => ({ ...file, bytesValue: Buffer.from(file.content, "base64") }));
}
