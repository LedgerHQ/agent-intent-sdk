---
"@ledgerhq/agent-intent-sdk": minor
---

Add Swap intents. `AgentIntentClient.createSwapIntent` signs and submits a Swap (`type: "swap"`, intent type `0x02`) and returns the frontend deeplink, like `createSendIntent`. `SwapIntent` carries the network (`SWAP_INTENT_NETWORKS`: `ethereum`, `ethereum_sepolia`, `arc_testnet`), the sender, the sold and bought Ledger currency ids, human-unit decimal amounts and the Swap API provider. `normalizeSwapIntent` applies the service's validation, `encodeSwapIntentTlv` returns the canonical bytes pinned to the service's vector, and `signSwapIntent` returns the signed request. Amounts stay decimal strings on the wire.
