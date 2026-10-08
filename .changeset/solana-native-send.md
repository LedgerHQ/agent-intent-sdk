---
"@ledgerhq/agent-intent-sdk": minor
---

Sign and submit native SOL sends: `createSendIntent` and `signCreateIntent` accept
a `SolanaSendIntent` (`network: "solana" | "solana_devnet"`, canonical base58
addresses, lamports, optional `memo`, no fee strategy), and `encodeSendIntentTlv`
encodes it as the service's canonical TLV. `SendIntent` is now the union of
`EvmSendIntent` and `SolanaSendIntent`, and `isSolanaSendIntent` tells them apart.
