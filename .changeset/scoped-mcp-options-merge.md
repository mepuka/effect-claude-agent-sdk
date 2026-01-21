---
"effect-claude-agent-sdk": minor
---

Add scoped MCP server creation, improved options merging, and hook utilities

- Add `createSdkMcpServerScoped` for automatic resource cleanup
- Improve options merging to properly combine hooks, env, mcpServers, agents, and extraArgs
- Add hook utilities for merging hook maps
- Fix layer composition in AgentRuntime and QuerySupervisor to include dependencies
- Make HookMap schema partial for better flexibility
