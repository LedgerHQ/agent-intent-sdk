# Agent guidance

## Scope

This repository publishes the headless `@ledgerhq/agent-intent-sdk` package.
It owns software agent identities, enrollment links and completion payloads,
LKRP/Keycloak authentication, canonical intent encoding and signing, and BFF
intent submission.

Do not add React, Vite, browser storage, Ledger device SDKs, application state,
frontend workflows, mocks, or the Agent Intent CLI to this package.

## Toolchain

- Node.js 24
- pnpm 12
- TypeScript 7
- Vitest 5
- oxlint and oxfmt
- Changesets

## Commands

- `pnpm build`
- `pnpm format`
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm pack:check`
- `pnpm verify`

Run `pnpm verify` before proposing a commit.

## Package rules

- Public exports come from `src/index.ts`.
- Runtime exports must point to compiled files in `dist/`.
- Preserve exact integer serialization for intent amounts.
- Treat cryptographic encodings and protocol payloads as compatibility
  boundaries; add vector tests for changes.
- Never log or persist secret keys, access tokens, or authentication cookies.
- Add a changeset for public API or behavior changes.
