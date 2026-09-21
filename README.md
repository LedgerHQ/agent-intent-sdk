# `@ledgerhq/agent-intent-sdk`

> [!CAUTION]
> **Status: UNSTABLE**
> This package is under active development. Breaking changes may be released
> while the Agent Intent protocol and service contract stabilize.

Headless TypeScript SDK for agents that enroll with Ledger Agent Intent,
authenticate through LKRP/Keycloak, and submit signed intents for human approval.

The package has no React, Vite, browser-storage, Ledger device, or application
state dependency. Secret-key persistence is deliberately left to consumers.

## Installation

This internal package is published to Ledger's JFrog npm registry:

```sh
pnpm add @ledgerhq/agent-intent-sdk
```

Your npm client must already be authenticated and configured for the Ledger
registry.

## Requirements

- Node.js 24 or newer
- An enrolled Agent Intent identity and Trustchain ID
- Network access to the selected Agent Intent and Keycloak environments

## Submit an intent

```ts
import { createAgentIntentClient, createSoftwareAgentIdentity } from "@ledgerhq/agent-intent-sdk";

const identity = createSoftwareAgentIdentity(savedSecretKey);
const client = createAgentIntentClient({
  bffBaseUrl: "https://global.api.stg.ledger-test.com/agent-intent",
  identity,
  trustchainId,
  environment: "staging",
});

const deeplink = await client.createSendIntent({
  type: "send",
  network: "ethereum",
  sender,
  recipient,
  amount: "1000000000000000000",
  asset: { type: "native" },
  feeStrategy: "medium",
  description: "Pay supplier",
});
```

Amounts accept decimal strings or `bigint` and are serialized as exact JSON
integers to avoid JavaScript precision loss.

## Enrollment fingerprint

Display the same fingerprint that the Ledger device shows:

```ts
import { formatAgentPublicKeyFingerprint } from "@ledgerhq/agent-intent-sdk";

console.log(formatAgentPublicKeyFingerprint(identity.publicKey));
```

The helper accepts compressed or uncompressed secp256k1 public keys.

## Development

```sh
mise install
pnpm install
pnpm verify
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch, changeset, review, and
release conventions.
