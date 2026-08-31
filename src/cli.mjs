import { loadConfig, requestSigned, requireAccessToken, verifyBundle } from "./client.mjs";
import { installBundle } from "./installer.mjs";

const help = `FLOWSTACK Source Registry\n\nUsage:\n  flowstack-blocks list [--type <block|component>] [--json]\n  flowstack-blocks search <query> [--type <block|component>] [--json]\n  flowstack-blocks info <id> [--json]\n  flowstack-blocks add <id> [--project <dir>] [--target <dir>] [--dry-run] [--force]\n\nAuthentication uses FLOWSTACK_BLOCKS_TOKEN or a mode-0600 config file. Tokens are never accepted as command arguments.`;

function parse(argv) {
  const options = {}; const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) { values.push(value); continue; }
    const key = value.slice(2);
    if (["json", "dry-run", "force", "help"].includes(key)) options[key] = true;
    else if (["project", "target", "type"].includes(key)) { if (!argv[index + 1]) throw new Error(`--${key} requires a value.`); options[key] = argv[++index]; }
    else throw new Error(`Unknown option: ${value}`);
  }
  return { values, options };
}

export async function run(argv, dependencies = {}) {
  const { values, options } = parse(argv);
  const [command, ...rest] = values;
  if (!command || options.help) { console.log(help); return; }
  const config = await (dependencies.loadConfig ?? loadConfig)();
  const request = (path) => (dependencies.requestSigned ?? requestSigned)(path, config, dependencies.fetch);
  if (command === "list" || command === "search") {
    if (options.type && !["block", "component"].includes(options.type)) throw new Error("--type must be block or component.");
    const parameters = new URLSearchParams();
    if (command === "search") parameters.set("q", rest.join(" "));
    if (options.type) parameters.set("type", options.type);
    const query = parameters.size ? `?${parameters}` : "";
    if (command === "search" && !rest.length) throw new Error("search requires a query.");
    const payload = await request(`/v1/public/catalog${query}`);
    options.json ? console.log(JSON.stringify(payload.items, null, 2)) : payload.items.forEach(({ id, name }) => console.log(`${id}\t${name}`));
    return;
  }
  if (command === "info") {
    if (rest.length !== 1) throw new Error("info requires one exact source item ID.");
    const payload = await request(`/v1/public/catalog/${encodeURIComponent(rest[0])}`);
    console.log(options.json ? JSON.stringify(payload.item, null, 2) : `${payload.item.name}\n${payload.item.id}\n\n${payload.item.description}`);
    return;
  }
  if (command === "add") {
    if (rest.length !== 1) throw new Error("add requires one exact source item ID.");
    const metadata = await request(`/v1/public/catalog/${encodeURIComponent(rest[0])}`);
    if (metadata.item.access === "paid") requireAccessToken(config);
    const payload = await request(`/v1/bundles/${encodeURIComponent(rest[0])}`);
    const files = verifyBundle(payload, { expectedItem: metadata.item, requestedId: rest[0] });
    const plan = await installBundle({ payload, files, project: options.project, target: options.target, force: options.force, dryRun: options["dry-run"] });
    console.log(`${plan.dryRun ? "Would install" : "Installed"} ${plan.id} at ${plan.target}`);
    for (const dependency of plan.dependencies) {
      console.log(`Dependency: ${dependency.name}@${dependency.version ?? "missing"} (${dependency.status}; requires ${dependency.range})`);
    }
    const missing = plan.dependencies.filter(({ status }) => status === "missing");
    if (missing.length) console.log(`Install required packages: ${missing.map(({ name, range }) => `${name}@"${range}"`).join(" ")}`);
    if (plan.collisions.length) console.log(`Collisions: ${plan.collisions.join(", ")}`);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}
