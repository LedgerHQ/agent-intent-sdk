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

A Solana send uses `network: "solana"` (or `"solana_devnet"`) and canonical
base58 addresses. It has no fee strategy, because the service sets the priority
fee, and it may carry an on-chain `memo`. A native SOL send gives its amount in
lamports:

```ts
const deeplink = await client.createSendIntent({
  type: "send",
  network: "solana",
  sender,
  recipient,
  amount: "10000000", // 0.01 SOL
  asset: { type: "native" },
  memo: "Invoice 42",
});
```

An SPL token send names the token by its mint, with the amount in the token's
base units:

```ts
asset: { type: "spl-token", assetReference: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, // USDC
amount: "1000000", // 1 USDC
```

Token-2022 tokens and an `assetOwner` are refused for now: no client can send
the former yet, and the service doesn't use the latter on Solana.

### Swap intents

```ts
const deeplink = await client.createSwapIntent({
  type: "swap",
  network: "ethereum",
  sender,
  fromAsset: "ethereum",
  toAsset: "ethereum/erc20/usd__coin",
  fromAmount: "0.5",
  toAmount: "1250",
  provider: "oneinch",
  description: "Rebalance to USDC",
});
```

`network` is one of `SWAP_INTENT_NETWORKS` (`ethereum`, `ethereum_sepolia`,
`arc_testnet`). `fromAmount` and `toAmount` are human-unit decimal strings
(`"0.5"` ETH, not wei), signed as given: `"1.5"` and `"1.50"` sign differently.

## List the agent's intents

```ts
import { isSendOperation, isSwapOperation } from "@ledgerhq/agent-intent-sdk";

let page = await client.listIntents({ status: ["signed", "broadcast"], pageSize: 10 });
while (true) {
  for (const { id, status, intent } of page.intents) {
    if (isSendOperation(intent)) console.log(id, status, intent.amount);
    else if (isSwapOperation(intent)) console.log(id, status, intent.fromAmount, intent.toAmount);
  }
  if (!page.nextCursor) break;
  page = await client.listIntents({ cursor: page.nextCursor });
}
```

The BFF scopes the listing to the authenticated agent: it only returns intents
that agent issued, most recent first. `status` takes any of
`AGENT_INTENT_STATUSES` and `pageSize` one of `AGENT_INTENT_PAGE_SIZES` (1, 5,
10, 50, 100; the BFF defaults to 10). `nextCursor` is opaque; when you pass it
back, the first page's filters and page size apply and the other options are
ignored. Amounts are exact strings: a send's `amount` is an integer in the
asset's smallest unit (wei, lamports, token base units), a swap's `fromAmount`
and `toAmount` are decimals in human units. One record with a missing or
mistyped field, `null` included, fails the whole page with an
`AgentIntentSdkError`: a record field such as `failureReason` on any intent, or
a send or swap field. An intent type the SDK doesn't know yet is passed
through, so narrow with `isSendOperation` or `isSwapOperation`. HTTP failures
throw `AgentIntentHttpError` with the BFF's `status` and `type`.

## Read one intent

```ts
const intent = await client.getIntent(intentId);
console.log(intent.status, intent.updatedAt);
```

An unknown id and another agent's intent both fail with `AgentIntentHttpError`
`status` 404. Amounts are exact decimal strings, as in the listing.

## Cancel an intent

An agent can withdraw an intent it created, as long as the user hasn't acted on it:

```ts
await client.cancelIntent(intentId);
```

A `created` or `crafted` intent can be cancelled, and cancelling an already
cancelled one also succeeds. Any other state, including one the user rejected or
signed, fails with `AgentIntentHttpError` `status` 400 and no `type`; call
`getIntent` to see which. Only the user rejects, in Ledger's interface. An intent
can't be edited: to change one, cancel it and create a new one.

## User-Agent

Outside browsers, requests send `User-Agent: ledger-agent-intent-sdk/<version> (agentic)`.
A custom `tokenProvider` sends its own authentication requests, so it must set that header itself.

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
deliver the serialized completion. The encrypted channel is the only delivery
path for version-2 and channel-bound recovery requests.

The candidate separates reaching the agent from delivering to it, so device
work only starts once the agent is known to be listening:

```ts
const candidate = createAgentEnrollmentChannelCandidate({ request, relayBaseUrl });

await candidate.connect(); // relay socket + key-confirmation handshake
const completion = await approveOnLedgerDevice(); // may take minutes
await candidate.deliver(completion); // resolves after the host acknowledges
```

`deliver()` connects implicitly when `connect()` was not called or the session
was lost (for example, the relay dropped the socket during device approval).
If a delivery fails, for example because `authenticate` rejected it or the
acknowledgement timed out, `deliver()` may be retried on the same candidate. Each
retry opens a fresh session with a new ephemeral key, and a newly connecting
candidate replaces one that has not delivered yet. A retry fails once the host has
finished, closed, or timed out.

### Recovery

A recovery request re-enrolls an existing agent key into its previous App-18
Trustchain. Its `source` is an `AgentRecoverySource`, which is any supported
`AgentSource` (see `isAgentRecoverySource`): recovery never depends on the
source. Bind it to a channel host the same way:

```ts
const request = createAgentRecoveryRequest(identity, {
  name,
  description,
  source,
  previousTrustchainId,
  expiresAt,
  channel: host.binding,
});
console.log(createAgentRecoveryUrl(frontendUrl, request));

const completion = await host.waitForCompletion({ request, authenticate, persist });
// completion: { version: 3, recovery: true, trustchainId, previousTrustchainId, ... }
```

For a recovery request, the host accepts only a version-3 recovery completion
whose agent key, previous Trustchain, and request signature match the signed
request, and whose `trustchainId` equals `previousTrustchainId`. For a version-2
request it accepts only a version-2 completion. `serializeAgentRecoveryCompletion`,
`parseAgentRecoveryCompletion`, and `validateAgentRecovery` are exported for the
frontend. The channel binding is optional and signed; an unbound recovery
request keeps its earlier canonical bytes.

### Security and timeouts

The channel key and every encrypted envelope are bound to the exact signed
request and envelope metadata. Handshake, completion, persistence, and
acknowledgement waits are bounded and capped by the signed request expiry.
The host allows 15 minutes for the frontend candidate to connect. After a
candidate connects, the cryptographic handshake, persistence, and
acknowledgement defaults are 30 seconds each. The wait between a completed
handshake and the delivered completion (device approval) is bounded only by
`completionTimeoutMs` (15 minutes) and the request expiry, on both the host and
the candidate. Applications may override these with the `timeouts` option.
While a session is open, both sides send the relay a text `ping` every 60
seconds, because the Trustchain relay drops a client after 5 minutes without a
frame sent to it. A failed `authenticate` call rejects only that delivery, so
the same or a later candidate can complete the same bounded host session. A
persistence failure closes the session without acknowledging. If enrollment was
committed before delivery failed, re-enroll the agent with a channel-bound
recovery request.

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
