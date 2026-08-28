# AGENTS.md — FLOWSTACK Blocks CLI

This public repository owns only the source-free `@flowstack-ui/blocks` client.

- Never add a catalog snapshot, Block source, preview source, assets, item-level
  Agent Knowledge, access tokens, customer data, or private workspace notes.
- Public discovery consumes allowlisted signed metadata. Paid downloads require
  an entitlement; future free delivery requires explicit item and service gates.
- Keep registry URLs HTTPS outside loopback, pin signing keys, verify all bytes
  before writes, and never accept tokens as command arguments or log them.
- Preserve dry-run, collision, explicit `--force`, rollback, safe-path, and
  consumer-owned-source semantics.
- Run `npm run check:repository` before handoff. Publication requires a protected
  reviewed tag workflow and is not implied by a green local pack.
