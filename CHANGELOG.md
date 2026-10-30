# @ledgerhq/agent-intent-sdk

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
