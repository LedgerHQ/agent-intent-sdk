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
and `toAmount` are decimals in human units. One record that lacks a required
field, or has a known field of the wrong type (`null` included, even on an
optional field such as `failureReason` or `memo`), fails the whole page with an
`AgentIntentSdkError`. An intent type the SDK doesn't know yet is passed
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

## Validate an enrollment or recovery link

`validateAgentEnrollment` and `validateAgentRecovery` take the link's query
parameters. A malformed link comes back with `reason: "malformed"` and the
field problems in `issues`, so an application can say what went wrong:

```ts
const validation = validateAgentEnrollment(search);
if (validation.status === "invalid" && validation.reason === "malformed") {
  // { status: "invalid", reason: "malformed",
  //   message: 'This agent enrollment link is malformed: "signature" is cut off (expected 128 hex characters).',
  //   issues: [{ field: "signature", problem: "truncated", expectedLength: 128 }] }
}
```

A field can be `missing`, `repeated` (the link was pasted twice), `empty`,
`truncated` or followed by `extra-characters` (hex fields), `too-long` (name and
description), have an `invalid-value`, carry an `unsupported-version`, or be
`unexpected`. `message` describes the first issue, and unexpected parameters
come after every other problem. `issues` only explains a rejection and never
changes which links are accepted, so two problems that do not reject a link on
their own, an unreadable `expiresAt` and a repeated channel field on a link
without a channel, are listed only when something else already rejects it. An
`unexpected` issue has a `parameter` instead of a `field`: it is the name as the
link carried it, so treat it as untrusted text and don't show it as is.
`AGENT_NAME_MAX_LENGTH` and `AGENT_DESCRIPTION_MAX_LENGTH` export the name and
description limits the validators apply.

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
retry opens a fresh session with a new ephemeral key. A retry fails once the host
has finished, closed, timed out, or stopped reconnecting.

As observed (this is not a documented relay contract), the Trustchain relay runs
a channel as one host and one candidate: it refuses a third socket and, when
either side leaves, closes the other about a second later. Except while a
completion is being authenticated or persisted, the host then reopens its socket
on the same key at once, so a reviewer who leaves the page can come back while
the request is unexpired. A candidate that connects in the second or two before
the host is back is rejected by the relay with "The enrollment relay rejected the
session."; a `connect()` or `deliver()` retry a couple of seconds later succeeds
once the host has reconnected.

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

The host reopens its relay socket at most 5 times in a row; a socket that stayed
open for at least 60 seconds before it was dropped resets that count, so drops
spread over a long wait do not add up. If a reopened socket fails before
connecting, the host retries after 1, 2 and 4 seconds, then every 5 seconds, and
gives up once reopening has failed for 60 seconds. A candidate that does not
finish the handshake within `handshakeTimeoutMs` no longer fails the host: the
host closes that socket and reopens it like a relay drop, with a fresh wait for
the next candidate, and this counts toward the 5 reconnects. Reconnecting never
extends `completionTimeoutMs` or the request expiry, and a socket lost while a
completion is being authenticated or persisted still fails the session. Both
limits fail with an error that starts with "Enrollment relay closed before
completion was acknowledged".

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
