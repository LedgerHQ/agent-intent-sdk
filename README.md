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

## Encrypted enrollment completion

Version-2 enrollment requests bind a one-use ephemeral relay host key into the
agent signature. A headless agent creates the host binding before creating the
URL; the socket opens lazily when it starts waiting. The host independently
authenticates the completion, persists it, and only then acknowledges:

```ts
const host = createAgentEnrollmentChannelHost({
  environment: "production",
  relayBaseUrl: "https://trustchain.api.live.ledger.com",
});
const request = createAgentEnrollmentRequest(identity, {
  name,
  description,
  source,
  expiresAt,
  channel: host.binding,
});
console.log(createAgentEnrollmentUrl(frontendUrl, request));

await host.waitForCompletion({
  request,
  authenticate: async (completion) => {
    // Prove this agent key belongs to the claimed Trustchains. Throw on failure.
  },
  persist: async (completion) => {
    // Persist completion.trustchainId and completion.accountAccess atomically.
  },
});
```

The browser validates the signed request, derives its trusted relay origin from
the signed environment, and uses `createAgentEnrollmentChannelCandidate()` to
deliver the serialized version-2 completion. Version-1 URLs and manual
completion parsing remain supported.

The channel key and every encrypted envelope are bound to the exact signed
request and envelope metadata. Handshake, completion, persistence, and
acknowledgement waits are bounded and capped by the signed request expiry.
The host allows 15 minutes for the user to finish Ledger approval and for the
frontend candidate to connect. After that connection, the cryptographic
handshake, persistence, and acknowledgement defaults are 30 seconds each; the
overall completion remains capped at 15 minutes. Applications may override them
with the `timeouts` option. A failed `authenticate` call rejects only that
candidate so a later valid browser can complete the same bounded host session.
A persistence failure closes the session without acknowledging; if enrollment
was committed before delivery failed, recover with the frontend's manual
completion payload.

The channel sends only the agent public key, App-18 Trustchain ID, and safe
App-16 environment/root/path references. It must never carry a serialized
Trustchain, `walletSyncEncryptionKey`, private key, JWT, or access token.

## Development

```sh
mise install
pnpm install
pnpm verify
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch, changeset, review, and
release conventions.
