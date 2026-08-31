import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const exists = (path) => access(path, constants.F_OK).then(() => true, () => false);
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/iu;
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u;
const comparatorPattern = /^(>=|<=|>|<|=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/u;

function fail(message) {
  throw new Error(message);
}

export function assertArtifactType(value) {
  const artifactType = value ?? "block";
  if (!["block", "component"].includes(artifactType)) fail(`Unsupported source artifact type: ${String(artifactType)}`);
  return artifactType;
}

function parseVersion(value) {
  const match = String(value).trim().match(versionPattern);
  if (!match) return null;
  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifiers(left, right) {
  const leftNumber = /^\d+$/u.test(left) ? Number(left) : null;
  const rightNumber = /^\d+$/u.test(right) ? Number(right) : null;
  if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber);
  if (leftNumber !== null) return -1;
  if (rightNumber !== null) return 1;
  return left.localeCompare(right);
}

function compareVersion(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return Math.sign(left.numbers[index] - right.numbers[index]);
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const comparison = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function parseRange(range) {
  if (typeof range !== "string" || range.trim() !== range || !range) return null;
  const clauses = range.split(/\s+/u);
  const parsed = clauses.map((clause) => {
    const match = clause.match(comparatorPattern);
    const version = match && parseVersion(`${match[2]}.${match[3] ?? 0}.${match[4] ?? 0}${match[5] ? `-${match[5]}` : ""}`);
    return match && version ? { operator: match[1] ?? "=", version } : null;
  });
  return parsed.every(Boolean) ? parsed : null;
}

function satisfies(version, clauses) {
  const current = parseVersion(version);
  if (!current) return false;
  return clauses.every(({ operator, version: required }) => {
    const comparison = compareVersion(current, required);
    return operator === ">=" ? comparison >= 0
      : operator === "<=" ? comparison <= 0
        : operator === ">" ? comparison > 0
          : operator === "<" ? comparison < 0
            : comparison === 0;
  });
}

export function sourceDependencyContract(item, artifactType = item?.artifactType ?? "block") {
  artifactType = assertArtifactType(artifactType);
  if (artifactType !== "component") return null;
  const dependencies = item?.dependencies;
  const packages = item?.dependencies?.packages;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)
    || Object.keys(dependencies).some((key) => key !== "packages")
    || !packages || typeof packages !== "object" || Array.isArray(packages) || !Object.keys(packages).length) {
    fail("Source component bundle must declare at least one package dependency.");
  }
  return Object.entries(packages).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, range]) => {
    if (!packageNamePattern.test(name)) fail(`Source component bundle declares an invalid package name: ${name}`);
    const clauses = parseRange(range);
    if (!clauses) fail(`Source component bundle declares an unsupported dependency range for ${name}: ${String(range)}`);
    return { name, range, clauses };
  });
}

async function findInstalledVersion(project, packageName) {
  const packagePath = packageName.split("/");
  let directory = project;
  while (true) {
    const manifest = join(directory, "node_modules", ...packagePath, "package.json");
    if (await exists(manifest)) {
      let installed;
      try {
        installed = JSON.parse(await readFile(manifest, "utf8"));
      } catch {
        fail(`Installed dependency manifest is invalid for ${packageName}.`);
      }
      if (typeof installed.version !== "string" || !parseVersion(installed.version)) {
        fail(`Installed dependency has an invalid version for ${packageName}.`);
      }
      return installed.version;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export async function inspectSourceDependencies(item, artifactType, project) {
  const contract = sourceDependencyContract(item, artifactType);
  if (contract === null) return [];
  const results = [];
  for (const dependency of contract) {
    const version = await findInstalledVersion(project, dependency.name);
    results.push({
      name: dependency.name,
      range: dependency.range,
      version,
      status: version === null ? "missing" : satisfies(version, dependency.clauses) ? "compatible" : "incompatible",
    });
  }
  return results;
}
