---
"@ledgerhq/agent-intent-sdk": minor
---

`validateAgentEnrollment` and `validateAgentRecovery` now say why a link is malformed. A result with `reason: "malformed"` carries `issues`, one per field problem (`missing`, `repeated`, `empty`, `truncated`, `extra-characters`, `too-long`, `invalid-value`, `unsupported-version`, `unexpected`), and its `message` names the first one instead of "malformed or incomplete" (an unsupported enrollment field no longer has its own message). Which links are accepted is unchanged, and so are `status` and `reason`. `issues` is only typed on the `malformed` variant, so narrow on `reason` before reading it. The name and description limits and the expected hex lengths are exported as `AGENT_NAME_MAX_LENGTH`, `AGENT_DESCRIPTION_MAX_LENGTH` and `AGENT_LINK_HEX_LENGTHS`.
