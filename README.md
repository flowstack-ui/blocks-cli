# FLOWSTACK Blocks CLI

Source-free authenticated client for paid FLOWSTACK Blocks and source-installed
components. The npm package contains no catalog snapshot, source artifact,
preview source, or item-level Agent
Knowledge. It retrieves customer-authorized metadata and signed bundles from
the private registry at command time.

Set `FLOWSTACK_BLOCKS_REGISTRY_URL` and the pinned
`FLOWSTACK_BLOCKS_PUBLIC_KEY`. Paid installation also requires
`FLOWSTACK_BLOCKS_TOKEN`. Alternatively store `token`, `registryUrl`, and
`publicKey` in `~/.config/flowstack/blocks.json` with mode `0600`. Tokens are
never command arguments and are never printed. Public metadata is source-free;
future items explicitly changed to `free` may install without a token.

```bash
npx @flowstack-ui/blocks list
npx @flowstack-ui/blocks list --type component
npx @flowstack-ui/blocks search "account activity"
npx @flowstack-ui/blocks info <block-id>
npx @flowstack-ui/blocks add <block-id> --dry-run
npx @flowstack-ui/blocks add <block-id>
```

Existing Blocks keep their `components/blocks/*` destination and
`.flowstack-block.json` receipt. Source components use their reviewed
application-owned destination (normally `components/ui/*`) and a distinct
`.flowstack-component.json` receipt. `--type block|component` filters discovery
without changing stable IDs or existing Block commands.

Installation downloads and verifies the signed bundle before writing. Existing
declared files abort installation unless `--force` is explicit. A dry run
reports collisions without writing. Forced installation stages a complete
replacement transaction while preserving unrelated files already in the
target directory and records exact bundle/file digests.

Every source component must declare a non-empty package dependency contract in
its signed metadata. `add`, including `--dry-run`, checks installed package
versions before any write. Compatible versions are reported, missing packages
are reported with the exact install specification, and an installed version
outside the declared range blocks installation. Existing Blocks retain their
legacy install behavior; this stricter dependency gate applies only to source
components. The client also recomputes each source component's aggregate
integrity from the verified file digests in canonical path order.

`add` binds the requested stable ID and the complete signed public metadata
projection to the downloaded bundle before installation. Artifact types are a
closed `block|component` set, so a source component cannot be downgraded to a
Block to bypass component validation. Targets, their existing descendants,
and staged paths must contain only ordinary directories and regular files;
symbolic links and special files are rejected before copying or replacement.

Individual and team licenses are lifetime entitlements; the registry, not this
client, decides which account or team a token authorizes. Public marketing may
show screenshots or compiled, no-source-map previews with purchase calls to
action. It must never install a paid source artifact into a public website
repository.

The repository's MIT license applies only to this public client. Paid source
artifacts are delivered under separate commercial licenses.
