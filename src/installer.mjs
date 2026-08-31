import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertArtifactType, inspectSourceDependencies } from "./dependencies.mjs";

const exists = (path) => access(path, constants.F_OK).then(() => true, () => false);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function safeRelative(path) {
  if (!path || isAbsolute(path) || path.split(/[\\/]/u).includes("..")) throw new Error(`Unsafe bundle path: ${path}`);
  return path;
}

async function pathDetails(path) {
  return lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
}

function rejectUnsafeEntry(path, details) {
  if (details.isSymbolicLink()) throw new Error(`Refusing source installation through symbolic link: ${path}`);
  if (!details.isDirectory() && !details.isFile()) throw new Error(`Refusing unsupported filesystem entry in source target: ${path}`);
}

async function assertSafeExistingPath(root, path) {
  const within = relative(root, path);
  if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("Source installation path escaped its validated root.");
  let cursor = root;
  const rootDetails = await pathDetails(cursor);
  if (!rootDetails) throw new Error(`Project directory does not exist: ${root}`);
  rejectUnsafeEntry(cursor, rootDetails);
  for (const part of within.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const details = await pathDetails(cursor);
    if (!details) return;
    rejectUnsafeEntry(cursor, details);
  }
}

async function assertSafeTree(path) {
  const details = await pathDetails(path);
  if (!details) return;
  rejectUnsafeEntry(path, details);
  if (!details.isDirectory()) return;
  for (const entry of await readdir(path)) await assertSafeTree(join(path, entry));
}

export async function installBundle({ payload, files, project = process.cwd(), target, force = false, dryRun = false }) {
  const artifactType = assertArtifactType(payload.item.artifactType ?? payload.artifactType);
  if (payload.artifactType !== undefined && assertArtifactType(payload.artifactType) !== artifactType) throw new Error("Registry bundle artifact type is inconsistent.");
  const provenanceName = artifactType === "block" ? ".flowstack-block.json" : ".flowstack-component.json";
  const projectRoot = resolve(project);
  const projectDetails = await pathDetails(projectRoot);
  if (!projectDetails?.isDirectory() || projectDetails.isSymbolicLink()) throw new Error(`Project directory does not exist or is unsafe: ${projectRoot}`);
  const defaultTarget = artifactType === "block"
    ? join("components", "blocks", payload.item.id.split("/").slice(-2).join("-"))
    : payload.item.destination ?? join("components", "ui", payload.item.id.split("/").slice(-2).join("-"));
  const targetRoot = resolve(projectRoot, target ?? defaultTarget);
  const within = relative(projectRoot, targetRoot);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("The source item target must remain below the project root.");
  await assertSafeExistingPath(projectRoot, targetRoot);
  await assertSafeTree(targetRoot);
  const declared = files.map(({ path }) => safeRelative(path));
  const dependencies = await inspectSourceDependencies(payload.item, artifactType, projectRoot);
  const incompatible = dependencies.filter(({ status }) => status === "incompatible");
  if (incompatible.length) {
    throw new Error(`Installed dependencies are incompatible:\n${incompatible.map(({ name, version, range }) => `  ${name}@${version} does not satisfy ${range}`).join("\n")}`);
  }
  const collisions = [];
  for (const path of [...declared, provenanceName]) if (await exists(join(targetRoot, path))) collisions.push(path);
  if (collisions.length && !force && !dryRun) throw new Error(`Installation would overwrite existing files. Re-run with --force only after reviewing them:\n${collisions.map((path) => `  ${path}`).join("\n")}`);
  const plan = { id: payload.item.id, target: within, collisions, force, dryRun, files: declared, dependencies };
  if (dryRun) return plan;

  const stage = `${targetRoot}.flowstack-stage-${randomUUID()}`;
  const backup = `${targetRoot}.flowstack-backup-${randomUUID()}`;
  let moved = false;
  try {
    if (await exists(stage) || await exists(backup)) throw new Error("A temporary source-install path already exists.");
    if (await exists(targetRoot)) await cp(targetRoot, stage, { recursive: true, errorOnExist: false });
    else await mkdir(stage, { recursive: true });
    await assertSafeTree(stage);
    for (const file of files) {
      const destination = join(stage, safeRelative(file.path));
      await assertSafeExistingPath(stage, destination);
      await mkdir(dirname(destination), { recursive: true });
      await assertSafeExistingPath(stage, destination);
      await writeFile(destination, file.bytesValue, { flag: "w" });
      const written = await pathDetails(destination);
      if (!written?.isFile() || written.isSymbolicLink() || sha256(await readFile(destination)) !== file.sha256) throw new Error(`Staged byte verification failed for ${file.path}.`);
    }
    const provenance = {
      $schema: artifactType === "block" ? "flowstack.block-install.v2" : "flowstack.source-install.v1",
      artifactType,
      id: payload.item.id,
      itemId: payload.item.id,
      bundleVersion: payload.version,
      bundleSha256: payload.bundleSha256,
      sourceIntegritySha256: artifactType === "component" ? payload.item.sourceIntegritySha256 : undefined,
      files: files.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
      dependencies: payload.item.dependencies?.packages ?? {},
    };
    const provenancePath = join(stage, provenanceName);
    await assertSafeExistingPath(stage, provenancePath);
    await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
    await assertSafeTree(stage);
    await assertSafeExistingPath(projectRoot, targetRoot);
    await assertSafeTree(targetRoot);
    if (await exists(targetRoot)) { await rename(targetRoot, backup); moved = true; }
    await rename(stage, targetRoot);
    if (moved) await rm(backup, { recursive: true, force: true });
    return plan;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    if (moved && !await exists(targetRoot)) await rename(backup, targetRoot);
    throw error;
  }
}
