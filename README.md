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
has finished, closed, or timed out.

As observed (this is not a documented relay contract), the Trustchain relay runs
a channel as one host and one candidate: it refuses a third socket and, when
either side leaves, closes the other about a second later. Except while a
completion is being authenticated or persisted, the host then reopens its socket
on the same key, at once after the first drop and with a backoff after later
ones (see [Security and timeouts](#security-and-timeouts)), so a reviewer who
leaves the page can come back while the request is unexpired. A candidate that
connects before the host is back is rejected by the relay with "The enrollment
relay rejected the session."; a `connect()` or `deliver()` retry succeeds once
the host has reconnected. After repeated quick drops the host can be away for up
to 5 seconds of backoff plus the relay's close delay of about 1.5 seconds, so
retry for at least 7 seconds.

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

### Rejection

When the user rejects an enrollment or recovery request, the frontend tells the
agent instead of leaving it to wait until the request expires:

```ts
await candidate.reject(); // resolves after the host acknowledges the rejection
```

On the host, `waitForCompletion` then rejects with
`AgentEnrollmentRejectedError`, whose `kind` is `"enrollment"` or `"recovery"`.
Nothing was authenticated or persisted. `isAgentEnrollmentRejectedError` checks
for an `Error` with that `name` and a valid `kind` rather than using
`instanceof`, so it also matches an error from another realm of the same process
or another copy of the SDK. An error that went through a structured clone, such
as `postMessage` to a worker, keeps neither its `name` nor its `kind`, so it no
longer matches:

```ts
try {
  await host.waitForCompletion({ request, authenticate, persist });
} catch (error) {
  if (!isAgentEnrollmentRejectedError(error)) throw error;
  console.log(`The user rejected this ${error.kind} request.`);
}
```

`reject()` connects first when no session is open, completes the
key-confirmation handshake like `deliver()`, and waits for the acknowledgement.
The handshake is bounded by `handshakeTimeoutMs`, the acknowledgement by
`acknowledgementTimeoutMs`, and both by `completionTimeoutMs` and the request
expiry. Its promise reports its own errors, never a delivery's: "Enrollment
rejection acknowledgement timed out.", "Enrollment rejection timed out."
(`completionTimeoutMs` or the request expiry), "Enrollment relay closed before
the rejection was sent." (during the handshake), and "Enrollment relay closed
before the rejection was acknowledged.". Once the host acknowledges, the
candidate is done: `connect()`, `deliver()` and `reject()` throw "This
enrollment request has already been rejected.". Like `deliver()`, `reject()`
throws synchronously when the candidate was closed, a delivery or rejection is
already running, or the request has expired.

After any other failure, `reject()` may be retried on a fresh session, for
example after the relay refused a candidate that arrived before the host
reconnected. A failed `reject()` does not prove the host kept waiting: when the
relay drops the host just as the rejection arrives, the host still honors it but
its acknowledgement is lost, and a retry then finds no host. A host that never
got the rejection waits until its timeouts or the request expiry.

Never call `reject()` once the device has committed the enrollment to the
Trustchain (the AddMember step): a rejection cannot undo that commit. The SDK
cannot see the device step, so the caller must enforce this rule. As a safety
net, `reject()` throws once `deliver()` has been called on that candidate, even
if the delivery failed, and the host refuses a rejection, from any candidate,
once it has received a well-formed completion for this request. The host counts
a completion as received once it parses, before `authenticate` runs, so a
completion that then fails authentication, even transiently, still makes it
refuse later rejections: the device committed AddMember before the frontend
delivered it, and a rejection honored then would leave a Trustchain member that
its agent treats as rejected. That refusal is final: `reject()` fails with "The
enrollment host already received a completion for this request; it can no
longer be rejected." and later calls throw the same error, so retries do not
keep making the relay drop the host, each drop delaying its next reopening.

The relay forwards only the messages of its own protocol, in the order that
protocol expects, and refuses anything else, so a rejection travels like a
completion: the candidate sends it as `TrustchainShareCredential` and the host
acknowledges it with `TrustchainAddedMember`. Both carry `{"encrypted":…}` and are bound to the
signed request like every other channel message. Only a rejection and its
acknowledgement carry a `reason`; a completion carries `completion`, and its
acknowledgement `acknowledged` and `digest`. Each side accepts only the body it
waits for, so neither takes a rejection for a completion or the reverse.

The host turns a rejection or a completion down with a `Failure`. The relay
reads a `Failure` as `{"type":…,"message":…}`, with a `type` from its own list,
so the host's `Failure` has the type `UNEXPECTED_SHARE_CREDENTIAL` and carries
its ciphertext in `message`, which the relay forwards untouched. As observed, the
relay then closes both sides, so nothing follows a `Failure` on that socket.

| Direction        | Message                     | Payload                                                   | Encrypted body                        | Meaning                                                                               |
| ---------------- | --------------------------- | --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| candidate → host | `TrustchainShareCredential` | `{"encrypted":…}`                                         | `{"reason":"user-rejected"}`          | The user rejected the request.                                                        |
| host → candidate | `TrustchainAddedMember`     | `{"encrypted":…}`                                         | `{"reason":"rejection-acknowledged"}` | The host accepted the rejection and ended its session.                                |
| host → candidate | `Failure`                   | `{"type":"UNEXPECTED_SHARE_CREDENTIAL","message":…}`      | `{"reason":"completion-received"}`    | The host refused the rejection: it already received a completion.                     |
| host → candidate | `Failure`                   | `{"type":"UNEXPECTED_SHARE_CREDENTIAL","message":…}`      | `{"reason":"reset"}`                  | The host turned down a completion or an unexpected frame, and dropped this candidate. |
| relay → either   | `Failure`                   | `{"type":"…","message":"…"}`, from the all-zero publisher | none                                  | The relay refused the session.                                                        |

The candidate reads a `Failure` as the host's only when it comes from the host
key, has the type `UNEXPECTED_SHARE_CREDENTIAL`, and decrypts. Any other
`Failure` is the relay's own and fails the session with "The enrollment relay
rejected the session.". Because the relay closes right after a `Failure`, the
candidate reads the frames it already received before it reports the close.
While rejecting, the candidate treats only `rejection-acknowledged` as success
and `completion-received` as the final refusal. Any other host `Failure`, such
as `reset`, makes `reject()` fail with "The enrollment host reset this
session.", which a retry on a fresh session may overcome.

A host whose SDK predates rejection reads the rejection as a malformed
completion and answers with a `Failure` the relay refuses, so `reject()` fails
with a relay error and that host keeps waiting within its usual
`candidateTimeoutMs`, `completionTimeoutMs` and the request expiry. Callers that
must not wait, such as a page the user is leaving, bound `reject()` themselves.

The host accepts a rejection only from the candidate that completed key
confirmation on its current socket, and only while it has received no
well-formed completion for this request. A rejection that does not decrypt,
comes from another key, arrives before key confirmation, carries another reason,
or carries anything besides its `reason` is handled like any unexpected frame:
it never ends the host session, but the host drops its current candidate, even a
confirmed one, and waits for another. So is any `Failure` the host receives,
which is always the relay's. A forged frame can therefore interrupt a reviewer,
who then rejects again on a fresh session, but cannot reject the request. A
rejection that arrives while a completion is being authenticated or persisted
waits behind it and has no effect. Frames from the confirmed candidate that the
host reads after the relay dropped its socket get no answer, but still count: a
rejection ends the session, and a well-formed completion, which the host then
neither authenticates nor persists, makes it refuse later rejections. After
accepting a rejection, the host acknowledges it, stops its timers and keepalive,
closes its socket, and does not reconnect; the relay closing the host afterwards
does not change the error.

Anyone who holds the signed link can complete the key-confirmation handshake, so
anyone who holds it can also reject the request, or send a well-formed
completion that makes the host refuse rejections. The link already grants that
much: it is what lets its holder reach the agent at all. The relay cannot forge
a rejection, because it never holds the channel key.

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
frame sent to it. The host also expects a frame back within 10 seconds of each
ping, normally the relay's `pong`; otherwise it treats the socket as dropped,
closes it, and reconnects as described below. A failed `authenticate` call
rejects only that delivery, so the same or a later candidate can complete the
same bounded host session. A persistence failure closes the session without
acknowledging. If enrollment was committed before delivery failed, re-enroll the
agent with a channel-bound recovery request.

The host does not limit how often it reopens its relay socket. It reopens at
once after the first drop, then after 1, 2 and 4 seconds, then every 5 seconds.
A reopened socket that fails before connecting, a handshake timeout, and a
missed ping reply follow the same backoff. A socket that stayed open for at
least 60 seconds before it was lost restarts the backoff; a missed ping reply is
detected at least 70 seconds after the socket opened, so the host reopens at
once after one. That window uses a monotonic clock, so a wall-clock change does
not move it. A candidate that does not finish the handshake within
`handshakeTimeoutMs` no longer fails the host: the host closes that socket and
reopens it like a relay drop, with a fresh wait for the next candidate.
Reconnecting never extends `completionTimeoutMs` or the request expiry. The host
stops and fails the session when:

- the request expires or `completionTimeoutMs` elapses;
- no candidate connects within `candidateTimeoutMs`, a wait that restarts on
  each reconnect after a candidate had connected;
- `close()` is called;
- the initial socket fails before it opens;
- persistence fails, or a socket is lost while a completion is being
  authenticated or persisted.

Before each reopen the host also checks the signed request expiry against the
wall clock, so it does not reconnect after a laptop slept past the expiry.

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
