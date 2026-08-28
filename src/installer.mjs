import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const provenanceName = ".flowstack-block.json";
const exists = (path) => access(path, constants.F_OK).then(() => true, () => false);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function safeRelative(path) {
  if (!path || isAbsolute(path) || path.split(/[\\/]/u).includes("..")) throw new Error(`Unsafe bundle path: ${path}`);
  return path;
}

export async function installBundle({ payload, files, project = process.cwd(), target, force = false, dryRun = false }) {
  const projectRoot = resolve(project);
  if (!(await stat(projectRoot).catch(() => null))?.isDirectory()) throw new Error(`Project directory does not exist: ${projectRoot}`);
  const defaultTarget = join("components", "blocks", payload.item.id.split("/").slice(-2).join("-"));
  const targetRoot = resolve(projectRoot, target ?? defaultTarget);
  const within = relative(projectRoot, targetRoot);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("The Block target must remain below the project root.");
  const declared = files.map(({ path }) => safeRelative(path));
  const collisions = [];
  for (const path of [...declared, provenanceName]) if (await exists(join(targetRoot, path))) collisions.push(path);
  if (collisions.length && !force && !dryRun) throw new Error(`Installation would overwrite existing files. Re-run with --force only after reviewing them:\n${collisions.map((path) => `  ${path}`).join("\n")}`);
  const plan = { id: payload.item.id, target: within, collisions, force, dryRun, files: declared };
  if (dryRun) return plan;

  const stage = `${targetRoot}.flowstack-stage-${randomUUID()}`;
  const backup = `${targetRoot}.flowstack-backup-${randomUUID()}`;
  let moved = false;
  try {
    if (await exists(targetRoot)) await cp(targetRoot, stage, { recursive: true, errorOnExist: false });
    else await mkdir(stage, { recursive: true });
    for (const file of files) {
      const destination = join(stage, safeRelative(file.path));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.bytesValue, { flag: "w" });
      if (sha256(await readFile(destination)) !== file.sha256) throw new Error(`Staged byte verification failed for ${file.path}.`);
    }
    const provenance = {
      $schema: "flowstack.block-install.v2", id: payload.item.id, bundleVersion: payload.version,
      bundleSha256: payload.bundleSha256, files: files.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
    };
    await writeFile(join(stage, provenanceName), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o600 });
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
