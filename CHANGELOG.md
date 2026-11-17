# @ledgerhq/agent-intent-sdk

## 0.3.0

### Minor Changes

- [#42](https://github.com/LedgerHQ/agent-intent-sdk/pull/42) [`206c20b`](https://github.com/LedgerHQ/agent-intent-sdk/commit/206c20bd9433459b45f51ad16e80e2ff2f65a9d4) Thanks [@mateuszmarcinkowski-ext-afk](https://github.com/mateuszmarcinkowski-ext-afk)! - Add `reject()` to the enrollment channel candidate, so the frontend can tell
  the agent that the user rejected an enrollment or recovery request instead of
  leaving it to wait until the request expires. `reject()` connects first when
  needed and, after key confirmation, sends the rejection the way a completion
  travels, because the Trustchain relay refuses any message outside its own
  protocol: a `TrustchainShareCredential` whose encrypted body is
  `{ reason: "user-rejected" }`. It resolves once the host answers with a
  `TrustchainAddedMember` whose encrypted body is
  `{ reason: "rejection-acknowledged" }`. Only these bodies carry a `reason`, so
  neither side takes a rejection for a completion or the reverse. Never call it
  once the device has committed the enrollment to the Trustchain: it throws once
  `deliver()` has been called, and the host refuses a rejection for good, with
  `{ reason: "completion-received" }`, once it has received a well-formed
  completion for the request, even one that then fails authentication. Neither
  check survives a page reload after a delivery that never reached the host, so
  the frontend must remember the device commit itself. After any other failure
  `reject()` may be retried, although the host may already have honored the
  rejection.

  The host then ends its session for good: `waitForCompletion` rejects with the
  new `AgentEnrollmentRejectedError`, whose `kind` is `"enrollment"` or
  `"recovery"`, and the host does not reconnect. `isAgentEnrollmentRejectedError`
  checks that error by shape, so it also matches an error from another realm or
  another copy of the SDK. A rejection that does not decrypt, comes from another
  key, or arrives before key confirmation never ends the host session: like any
  unexpected frame, it only makes the host drop its current candidate. Anyone
  who holds the signed link can complete key confirmation, and so can also reject
  the request; the link already lets its holder reach the agent.

  The host's refusals now reach the candidate. The relay accepts a `Failure` only
  as `{ type, message }` with a `type` from its own list, so it refused the
  host's encrypted `Failure` and closed both sides. The host now sends
  `{ type: "UNEXPECTED_SHARE_CREDENTIAL", message: <ciphertext> }`, which the
  relay forwards before it closes both sides, with the encrypted body
  `{ reason: "reset" }` when it turns a completion down, instead of
  `{ rejected: true }`. The candidate takes a `Failure` for the host's only when it
  comes from the host key with that type and decrypts, and reads it before the
  close that follows. Candidates from earlier versions read it as the relay's own
  `Failure`, which fails that delivery just the same.

  A host from an earlier version reads a rejection as a malformed completion, so
  `reject()` fails and that host keeps waiting until its timeouts or the request
  expiry. Bound `reject()` where the caller cannot wait.

  `AgentEnrollmentChannelCandidate` gains the required `reject()` member, so code
  that implements that type, such as a test double, must add it.

### Patch Changes

- [#55](https://github.com/LedgerHQ/agent-intent-sdk/pull/55) [`25b3982`](https://github.com/LedgerHQ/agent-intent-sdk/commit/25b3982c197de5fdd282a50d4bdf354317ff6ada) Thanks [@Justkant](https://github.com/Justkant)! - Update `bs58` to 6.0.0, which ships its own types and no longer depends on `safe-buffer`. Solana addresses decode to the same bytes.

- [#42](https://github.com/LedgerHQ/agent-intent-sdk/pull/42) [`206c20b`](https://github.com/LedgerHQ/agent-intent-sdk/commit/206c20bd9433459b45f51ad16e80e2ff2f65a9d4) Thanks [@mateuszmarcinkowski-ext-afk](https://github.com/mateuszmarcinkowski-ext-afk)! - The enrollment channel host reconnects after the Trustchain relay drops it, so a reviewer who leaves the enrollment page can come back and approve while the request is unexpired. The relay closes the host once its candidate leaves; the host now reopens on the same key within the existing completion deadline, at once after the first drop, then after 1, 2 and 4 seconds, then every 5 seconds, with no limit on the number of reconnects. A socket that stayed open for at least 60 seconds before it dropped restarts that backoff. The host stops when the signed request expires (also checked against the wall clock before each reopen), when `completionTimeoutMs` elapses, on `close()`, when the candidate calls `reject()`, or when a socket is lost while a completion is being authenticated or persisted. After each keepalive ping the host expects a frame back within 10 seconds; a socket that stays silent is closed and reopened like a relay drop. A candidate that does not finish the handshake within `handshakeTimeoutMs` no longer fails the host; the host reopens and waits for another candidate. A reviewer who leaves, or refuses on the device without the frontend calling `reject()`, leaves the host waiting until the request expires, `completionTimeoutMs` elapses, or the caller closes it. A host closed or timed out while a completion is being authenticated no longer persists that completion afterwards, and neither the relay dropping the host nor the host closing while a completion is still being decrypted lets that completion be authenticated or persisted.

- [#42](https://github.com/LedgerHQ/agent-intent-sdk/pull/42) [`206c20b`](https://github.com/LedgerHQ/agent-intent-sdk/commit/206c20bd9433459b45f51ad16e80e2ff2f65a9d4) Thanks [@mateuszmarcinkowski-ext-afk](https://github.com/mateuszmarcinkowski-ext-afk)! - A candidate that reaches the relay before the host now fails with "The enrollment relay rejected the session." instead of "Enrollment channel host does not match the signed request."

## 0.2.0

### Minor Changes

- [#41](https://github.com/LedgerHQ/agent-intent-sdk/pull/41) [`4f54f41`](https://github.com/LedgerHQ/agent-intent-sdk/commit/4f54f41894ebbdf28c8d39eff4e656d89061c0e2) Thanks [@michaldebek-ext-max](https://github.com/michaldebek-ext-max)! - Export `canApproveSwapQuote`, `needsAllowanceReset`, `isSwapApprovalRequired`, `parseErc20Approval` and `parseBaseUnits`: the rules that decide whether the Agent Intent app can send a swap quote's token approval, for wallet-cli and the app to share.

### Patch Changes

- [#50](https://github.com/LedgerHQ/agent-intent-sdk/pull/50) [`0858e92`](https://github.com/LedgerHQ/agent-intent-sdk/commit/0858e92ccb17f94fd7ef1106fc5e0b2b1a9b637b) Thanks [@michaldebek-ext-max](https://github.com/michaldebek-ext-max)! - `canApproveSwapQuote` refuses a quote whose approval spender is the zero address.

## 0.1.0

### Minor Changes

- [#13](https://github.com/LedgerHQ/agent-intent-sdk/pull/13) [`4ceba0a`](https://github.com/LedgerHQ/agent-intent-sdk/commit/4ceba0ae07172ba0287dd9c0dfc6ae4068208957) Thanks [@michaldebek-ext-max](https://github.com/michaldebek-ext-max)! - Extend the controlled agent sources with `claude-code`, `codex`, `cursor`,
  `muse`, `grok-bot`, and `other`, so an agent can declare the runtime it runs in.
  `isAgentSource` now accepts any value, so untrusted input can be checked without
  a separate string guard.

- [#37](https://github.com/LedgerHQ/agent-intent-sdk/pull/37) [`22d57e6`](https://github.com/LedgerHQ/agent-intent-sdk/commit/22d57e62ad18da10f69e9317c1c9b8bcca9049b6) Thanks [@michaldebek-ext-max](https://github.com/michaldebek-ext-max)! - Add `buildAgentSetupPrompt(appUrl)`, the prompt a user pastes into their agent to enroll it with the Agent Intent app at that URL.

- [#22](https://github.com/LedgerHQ/agent-intent-sdk/pull/22) [`531d1c2`](https://github.com/LedgerHQ/agent-intent-sdk/commit/531d1c2143cafdd49c3c436cac5b2c4313e3f665) Thanks [@michaldebek-ext-max](https://github.com/michaldebek-ext-max)! - Add `AgentIntentClient.cancelIntent(intentId)`.

- [#17](https://github.com/LedgerHQ/agent-intent-sdk/pull/17) [`a0d2eb0`](https://github.com/LedgerHQ/agent-intent-sdk/commit/a0d2eb0a2419894c78c30d533f98e4dadca7c46e) Thanks [@michaldebek-ext-max](https://github.com/michaldebek-ext-max)! - Add `AgentIntentClient.getIntent(intentId)` and export `parseAgentIntentRecord`.

- [`8e23048`](https://github.com/LedgerHQ/agent-intent-sdk/commit/8e23048998f4af66864545d04d316d2971601cdd) Thanks [@Justkant](https://github.com/Justkant)! - Publish the initial headless Agent Intent SDK with enrollment, authentication,
  canonical signing, and intent submission APIs.

- [#16](https://github.com/LedgerHQ/agent-intent-sdk/pull/16) [`77af48f`](https://github.com/LedgerHQ/agent-intent-sdk/commit/77af48f2e23520858ee8b9f770fed31201ab85e1) Thanks [@michaldebek-ext-max](https://github.com/michaldebek-ext-max)! - Add `AgentIntentClient.listIntents(query)` with status filters, page size and cursor pagination, and export `AgentIntentRecord`, `AgentIntentPage`, `AGENT_INTENT_STATUSES`, `AGENT_INTENT_PAGE_SIZES`, `isAgentIntentStatus`, `isAgentIntentPageSize` and `parseAgentIntentPage`. `AgentIntentSdkError` now accepts a `cause`.

- [#36](https://github.com/LedgerHQ/agent-intent-sdk/pull/36) [`4218d88`](https://github.com/LedgerHQ/agent-intent-sdk/commit/4218d888c723b70c4a411f2f3e83ebbe62b249c8) Thanks [@mmysl-ledger-ext](https://github.com/mmysl-ledger-ext)! - `validateAgentEnrollment` and `validateAgentRecovery` now say why a link is malformed. A result with `reason: "malformed"` carries `issues`, one per field problem (`missing`, `repeated`, `empty`, `truncated`, `extra-characters`, `too-long`, `invalid-value`, `unsupported-version`, `unexpected`), and its `message` names the first one instead of "malformed or incomplete" (an unsupported enrollment field and an invalid expiry no longer have their own messages). Unexpected parameters come last in both validators, and an `unexpected` issue carries the untrusted parameter name as `parameter` instead of `field`. Which links are accepted is unchanged, and so are `status` and `reason`. `issues` is only typed on the `malformed` variant, so narrow on `reason` before reading it; it always holds at least one issue. The name and description limits are exported as `AGENT_NAME_MAX_LENGTH` and `AGENT_DESCRIPTION_MAX_LENGTH`.

- [#2](https://github.com/LedgerHQ/agent-intent-sdk/pull/2) [`da61011`](https://github.com/LedgerHQ/agent-intent-sdk/commit/da610118d9f356985bbfeede7f67660481912715) Thanks [@Justkant](https://github.com/Justkant)! - Add signed version-2 enrollment requests and a request-bound, authenticated,
  timeout-bounded completion channel over the Trustchain QR relay. The host now
  authenticates completions before durable persistence and acknowledgement while
  preserving manual recovery and allowing a separate 15-minute window for
  device-approved enrollment before the 30-second cryptographic handshake.

- [#15](https://github.com/LedgerHQ/agent-intent-sdk/pull/15) [`3f27d3d`](https://github.com/LedgerHQ/agent-intent-sdk/commit/3f27d3d43d78d6cd46d7071a58d42abbf78608ed) Thanks [@michaldebek-ext-max](https://github.com/michaldebek-ext-max)! - Let every supported agent source recover an existing identity. `SUPPORTED_AGENT_RECOVERY_SOURCES` is now `SUPPORTED_AGENT_SOURCES`, `AgentRecoverySource` is `AgentSource`, and `isAgentRecoverySource` delegates to `isAgentSource`, so `createAgentRecoveryRequest` and `validateAgentRecovery` accept `claude-code`, `codex`, `cursor`, `muse`, `grok-bot` and `other` as well as `openclaw` and `hermes`. Recovery never depended on the source: it is only a signed field. Values outside the controlled list are still rejected.

- [#21](https://github.com/LedgerHQ/agent-intent-sdk/pull/21) [`30f9d9f`](https://github.com/LedgerHQ/agent-intent-sdk/commit/30f9d9f35a38bb5fd6c22d9f3c28effb1056e8da) Thanks [@michaldebek-ext-max](https://github.com/michaldebek-ext-max)! - Sign and submit native SOL sends: `createSendIntent` and `signCreateIntent` accept
  a `SolanaSendIntent` (`network: "solana" | "solana_devnet"`, canonical base58
  addresses, lamports, optional `memo`, no fee strategy), and `encodeSendIntentTlv`
  encodes it as the service's canonical TLV. `SendIntent` is now the union of
  `EvmSendIntent` and `SolanaSendIntent`, and `isSolanaSendIntent` tells them apart. Solana addresses are decoded with `bs58`, which the package now depends on.

  Validate send intents the way the service does: `description` (also a Swap's) and `memo` are limited to 280 UTF-16 code units (an emoji counts twice), an `amount` of zero is refused on every network, a `memo` on an Ethereum send is refused instead of being submitted unsigned, and an unknown `network` is reported as such. `SendIntent` is now a union, so code that reads `feeStrategy` from a `SendIntent` or a `SignedCreateIntent["intent"]` has to narrow it first, for example with `isSolanaSendIntent`.

- [#25](https://github.com/LedgerHQ/agent-intent-sdk/pull/25) [`c8effd1`](https://github.com/LedgerHQ/agent-intent-sdk/commit/c8effd17875ccfdad1dd24d4b325e558387f8e96) Thanks [@michaldebek-ext-max](https://github.com/michaldebek-ext-max)! - Sign and submit SPL token sends on Solana: a `SolanaSendIntent` takes an `SplTokenAsset` (`{ type: "spl-token", assetReference: <mint> }`), with the amount in the token's base units.

- [#14](https://github.com/LedgerHQ/agent-intent-sdk/pull/14) [`b17354e`](https://github.com/LedgerHQ/agent-intent-sdk/commit/b17354ea029ae53664dfc67058a0896be4e14c40) Thanks [@Justkant](https://github.com/Justkant)! - Split the enrollment channel candidate into `connect()` and `deliver()`, so a
  frontend can reach the agent before device approval and deliver afterwards on
  the same session. `deliver()` still connects implicitly. A failed delivery can now
  be retried on the same candidate, and the host lets a newly connecting
  candidate replace one that has not delivered yet.

  Move the agent recovery request and version-3 recovery completion format into
  the SDK (`createAgentRecoveryRequest`, `validateAgentRecovery`,
  `serializeAgentRecoveryCompletion`, `parseAgentRecoveryCompletion`, and
  related helpers). Recovery request `source` is typed as `AgentRecoverySource`
  (`openclaw` or `hermes`), with an `isAgentRecoverySource` guard. Recovery requests can carry a signed channel binding
  (`createAgentRecoveryRequest` returns an `AgentRecoveryChannelRequest` when given
  a channel), and the channel host accepts a recovery completion for a recovery
  request.

- [#19](https://github.com/LedgerHQ/agent-intent-sdk/pull/19) [`14abc5f`](https://github.com/LedgerHQ/agent-intent-sdk/commit/14abc5f5a26517cd2dd8bccb95395fd31c889052) Thanks [@michaldebek-ext-max](https://github.com/michaldebek-ext-max)! - Add AgentIntentClient.createSwapIntent and createSignedSwapIntent, and export SWAP_INTENT_NETWORKS, normalizeSwapIntent, encodeSwapIntentTlv and signSwapIntent.

- [#27](https://github.com/LedgerHQ/agent-intent-sdk/pull/27) [`530e684`](https://github.com/LedgerHQ/agent-intent-sdk/commit/530e68484401a9ccb42bb968374d31a49ab22f28) Thanks [@michaldebek-ext-max](https://github.com/michaldebek-ext-max)! - Type listed intents as `AgentIntentSendOperation` (with Solana's `memo`) or `AgentIntentSwapOperation`, narrowed with `isSendOperation` and `isSwapOperation`, and reject a send or swap with a missing or mistyped field.

### Patch Changes

- [#29](https://github.com/LedgerHQ/agent-intent-sdk/pull/29) [`771e158`](https://github.com/LedgerHQ/agent-intent-sdk/commit/771e1580ec4279e6bbcdf0ef652402389e72f746) Thanks [@Justkant](https://github.com/Justkant)! - Fix Agent Intent frontend links to use the new hosts: `https://app.agents.ledger-test.com/` for staging and `https://app.agents.ledger.com/` for production. Enrollment and recovery links and intent deeplinks returned by the BFF now point at these hosts.

- [#20](https://github.com/LedgerHQ/agent-intent-sdk/pull/20) [`0393937`](https://github.com/LedgerHQ/agent-intent-sdk/commit/0393937a24a835dab06a209fe7ac61fbfd10add7) Thanks [@michaldebek-ext-max](https://github.com/michaldebek-ext-max)! - In Node, requests to the Agent Intent BFF and to Keycloak / LKRP authentication now send `User-Agent: ledger-agent-intent-sdk/<version> (agentic)`, so agent traffic can be monitored on its own in Cloudflare and Datadog. Browsers keep their own User-Agent, so web apps using the SDK send no extra header and trigger no CORS preflight.

- [#31](https://github.com/LedgerHQ/agent-intent-sdk/pull/31) [`417af0f`](https://github.com/LedgerHQ/agent-intent-sdk/commit/417af0f30701e19efd4509a6879971235ce7ab11) Thanks [@oscarchaix](https://github.com/oscarchaix)! - Keep enrollment and recovery channels open past the Trustchain relay's 5-minute
  idle timeout. The relay dropped a host or candidate that went 5 minutes without
  a frame sent to it, so a user who took longer to open the link or approve on the
  device lost the session even though the signed request had not expired. Both
  sides now send the relay a text `ping` every 60 seconds while the session is
  open, and ignore its `pong` replies.

  `host.close()` now ends the host session directly, stopping its timers and
  pings and rejecting `waitForCompletion` with a "session has been closed" error,
  instead of waiting for the socket to report that it closed.
