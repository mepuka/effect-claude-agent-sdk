---
"effect-claude-agent-sdk": minor
---

Upgrade @anthropic-ai/claude-agent-sdk from v0.2.29 to v0.2.45

**New Options fields:** `thinking`, `effort`, `debug`, `debugFile`, `sessionId`, `persistSession`

**New QueryHandle methods:** `initializationResult()`, `stopTask(taskId)`

**New message types:** `SDKTaskStartedMessage`, `stop_reason` on result messages, `max_output_tokens` assistant error

**New hook events:** `TeammateIdle`, `TaskCompleted`

**New sandbox config:** `SandboxFilesystemConfig` (allowWrite/denyWrite/denyRead), `allowManagedDomainsOnly` on network config

**Fixes:** Added missing `NotificationHookSpecificOutput`, `permissionMode` on `SDKStatusMessage`, `agent_type` on `SubagentStopHookInput`
