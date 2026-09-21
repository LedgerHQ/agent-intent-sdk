# Frontend migration

Do not switch `agent-intent-frontend` to this package until the initial `0.1.0`
release is available from Ledger JFrog.

After publishing:

1. Replace the frontend's `workspace:*` dependency with the released exact SDK
   version.
2. Move `packages/agent-intent-sdk/src/cli.ts` into a frontend-owned CLI
   location. It imports frontend-owned account-access and temporary Cloud Sync
   adapters, so it is intentionally not part of this SDK.
3. Update the CLI build entry and TypeScript include paths.
4. Remove the remaining local `packages/agent-intent-sdk` sources and workspace
   entry.
5. Install with the frozen lockfile updated and run the frontend green gate.
6. Verify both browser enrollment flows and the bundled CLI integration tests
   against the installed package.

Keep the package version exact in the frontend until the SDK API is declared
stable.
