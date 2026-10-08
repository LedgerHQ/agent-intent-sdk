---
"@ledgerhq/agent-intent-sdk": minor
---

Sign and submit native SOL sends: `createSendIntent` and `signCreateIntent` accept
a `SolanaSendIntent` (`network: "solana" | "solana_devnet"`, canonical base58
addresses, lamports, optional `memo`, no fee strategy), and `encodeSendIntentTlv`
encodes it as the service's canonical TLV. `SendIntent` is now the union of
`EvmSendIntent` and `SolanaSendIntent`, and `isSolanaSendIntent` tells them apart.

Validate send intents the way the service does: `description` (also a Swap's) and `memo` are limited to 280 UTF-16 code units (an emoji counts twice), an `amount` of zero is refused on every network, a `memo` on an Ethereum send is refused instead of being submitted unsigned, and an unknown `network` is reported as such. `SendIntent` is now a union, so code that reads `feeStrategy` from a `SendIntent` or a `SignedCreateIntent["intent"]` has to narrow it first, for example with `isSolanaSendIntent`.
