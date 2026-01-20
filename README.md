# effect-claude-agent-sdk

Effect-native bindings for the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk). Build type-safe AI agents with Effect's powerful service composition, streaming, and error handling.

## Features

- **Effect Services** - `AgentSdk` and `AgentRuntime` as composable Effect services
- **Type-Safe Tools** - Define MCP tools with Effect Schema, automatic Zod conversion
- **Stream-Based I/O** - Query results as Effect Streams with backpressure
- **Lifecycle Hooks** - Effect-based hook handlers for SDK events
- **Query Supervision** - Concurrency limits, timeouts, and automatic cleanup
- **Layered Configuration** - Environment-aware config with sensible defaults

## Installation

```bash
bun add effect-claude-agent-sdk effect @effect/platform @effect/platform-bun
```

## Requirements

- [Bun](https://bun.sh) 1.0+ (peer dependency)
- `ANTHROPIC_API_KEY` environment variable

## Quick Start

```ts
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { AgentSdk } from "effect-claude-agent-sdk"

const program = Effect.scoped(
  Effect.gen(function* () {
    const sdk = yield* AgentSdk
    const handle = yield* sdk.query("What is 2 + 2?")

    yield* handle.stream.pipe(
      Stream.tap((message) => Console.log(message)),
      Stream.runDrain
    )
  }).pipe(Effect.provide(AgentSdk.layerDefault))
)

Effect.runPromise(program)
```

## Core Concepts

### AgentSdk

The low-level service wrapping the Claude Agent SDK. Use this when you need direct control over queries.

```ts
import { AgentSdk, AgentSdkConfig } from "effect-claude-agent-sdk"

// Default layer (uses environment variables)
AgentSdk.layerDefault

// Custom configuration
AgentSdk.layer.pipe(
  Layer.provide(
    AgentSdkConfig.layerFromEnv("MY_PREFIX") // reads MY_PREFIX_API_KEY, etc.
  )
)
```

### AgentRuntime

A higher-level service that adds supervision, retries, and timeouts on top of `AgentSdk`.

```ts
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { AgentRuntime } from "effect-claude-agent-sdk"

const program = Effect.gen(function* () {
  const runtime = yield* AgentRuntime

  // Get stats about active queries
  const stats = yield* runtime.stats
  console.log(`Active queries: ${stats.activeCount}`)

  // Stream responses directly
  yield* runtime
    .stream("Explain quantum computing")
    .pipe(Stream.runForEach((msg) => Effect.log(msg)))

  // Interrupt all active queries
  yield* runtime.interruptAll
}).pipe(Effect.provide(AgentRuntime.layerDefault))
```

### QueryHandle

Both services return a `QueryHandle` for controlling the query:

```ts
interface QueryHandle {
  readonly stream: Stream.Stream<SDKMessage, AgentSdkError>
  readonly interrupt: Effect.Effect<void, AgentSdkError>
  readonly closeInput: Effect.Effect<void>
  readonly sendUserMessage: (message: SDKUserMessage) => Effect.Effect<void, AgentSdkError>
}
```

## Defining Tools

Define type-safe MCP tools using Effect Schema:

```ts
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Tools } from "effect-claude-agent-sdk"

// Define a tool with typed parameters and return value
const Calculator = Tools.Tool.make("calculator", {
  description: "Perform arithmetic operations",
  parameters: {
    operation: Schema.Literal("add", "subtract", "multiply", "divide"),
    a: Schema.Number,
    b: Schema.Number
  },
  success: Schema.Number,
  failure: Schema.String
})

// Create a toolkit from multiple tools
const toolkit = Tools.Toolkit.make(Calculator)

// Implement handlers
const handlers = {
  calculator: ({ operation, a, b }) =>
    Effect.gen(function* () {
      switch (operation) {
        case "add":
          return a + b
        case "subtract":
          return a - b
        case "multiply":
          return a * b
        case "divide":
          if (b === 0) return yield* Effect.fail("Division by zero")
          return a / b
      }
    })
}
```

### Tool Annotations

Add metadata to tools for better documentation:

```ts
const ReadFile = Tools.Tool.make("read_file", {
  description: "Read contents of a file",
  parameters: { path: Schema.String },
  success: Schema.String
})
  .annotate(Tools.Tool.Readonly, true)
  .annotate(Tools.Tool.OpenWorld, true)
```

## MCP Servers

Create in-process MCP servers with your tools:

```ts
import * as Effect from "effect/Effect"
import { AgentSdk, Mcp, Tools } from "effect-claude-agent-sdk"

const program = Effect.scoped(
  Effect.gen(function* () {
    const sdk = yield* AgentSdk
    const toolkit = Tools.Toolkit.make(Calculator)
    const tools = yield* Mcp.toolsFromToolkit(toolkit, handlers)

    const server = yield* sdk.createSdkMcpServer({
      name: "my-tools",
      version: "1.0.0",
      tools
    })

    const handle = yield* sdk.query("Calculate 15 * 7", {
      tools: ["calculator"],
      mcpServers: { "my-tools": server }
    })

    // ...
  })
)
```

## Hooks

Handle SDK lifecycle events with Effect:

```ts
import * as Effect from "effect/Effect"
import { Hooks } from "effect-claude-agent-sdk"

const myHook = Hooks.Hook.callback((input, context) =>
  Effect.gen(function* () {
    if (input.type === "PreToolUse") {
      yield* Effect.log(`Tool ${input.tool_name} about to be called`)
    }
    return {} // Hook output
  })
)

// Create a matcher for specific events
const matcher = Hooks.Hook.matcher({
  matcher: "PreToolUse",
  timeout: "30 seconds",
  hooks: [yield* myHook]
})
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | API key for Claude | Required |
| `AGENTSDK_MODEL` | Model to use | `claude-sonnet-4-20250514` |
| `AGENTSDK_MAX_TURNS` | Maximum conversation turns | `100` |
| `AGENTSDK_SYSTEM_PROMPT` | System prompt | None |

### Runtime Configuration

```ts
import { AgentRuntimeConfig } from "effect-claude-agent-sdk"

const config = AgentRuntimeConfig.layer({
  queryTimeout: "5 minutes",
  firstMessageTimeout: "30 seconds",
  retryMaxRetries: 3,
  retryBaseDelay: "1 second",
  maxConcurrentQueries: 10
})
```

## Experimental Features

### Rate-Limited Tool Handlers

```ts
import { Experimental, Tools } from "effect-claude-agent-sdk"

const handlers = {
  echo: ({ text }) => Effect.succeed(text)
}

const limited = Experimental.RateLimiter.rateLimitHandlers(
  handlers,
  { limit: 10, window: "1 minute" },
  { keyPrefix: "tools" }
)

// Provide the rate limiter layer
Effect.provide(Experimental.RateLimiter.layerMemory)
```

### Persisted Input Queue

```ts
import { Experimental, Schema } from "effect-claude-agent-sdk"

const program = Effect.gen(function* () {
  const queue = yield* Experimental.PersistedQueue.makeUserMessageQueue()
  const adapter = yield* Experimental.PersistedQueue.makeInputAdapter(queue)

  const message: Schema.SDKUserMessage = {
    type: "user",
    session_id: "",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
    parent_tool_use_id: null
  }

  yield* adapter.send(message)
}).pipe(Effect.provide(Experimental.PersistedQueue.layerMemory))
```

### Audit Event Log

```ts
import { Experimental } from "effect-claude-agent-sdk"

const program = Effect.scoped(
  Effect.gen(function* () {
    const log = yield* Experimental.EventLog.EventLog

    yield* log.write({
      schema: Experimental.EventLog.AuditEventSchema,
      event: "hook_event",
      payload: {
        sessionId: "session-1",
        hook: "SessionStart",
        outcome: "success"
      }
    })
  }).pipe(
    Effect.provide([
      Experimental.EventLog.layerMemory,
      Experimental.EventLog.layerAuditHandlers
    ])
  )
)
```

## API Reference

### Services

| Service | Description |
|---------|-------------|
| `AgentSdk` | Low-level SDK wrapper with `query()` and `createSdkMcpServer()` |
| `AgentRuntime` | High-level runtime with supervision, retries, timeouts |
| `QuerySupervisor` | Manages concurrent queries and cleanup |

### Modules

| Module | Description |
|--------|-------------|
| `Schema` | Effect Schema definitions for SDK types |
| `Tools` | Tool and Toolkit definitions |
| `Hooks` | Hook handlers and matchers |
| `Mcp` | MCP server creation utilities |
| `Experimental` | Rate limiting, persisted queues, event logging |

### Layers

| Layer | Description |
|-------|-------------|
| `AgentSdk.layerDefault` | Default SDK configuration |
| `AgentSdk.layerDefaultFromEnv(prefix)` | SDK from environment with custom prefix |
| `AgentRuntime.layerDefault` | Default runtime with supervision |
| `AgentRuntime.layerDefaultFromEnv(prefix)` | Runtime from environment |

## Examples

See the [`examples/`](./examples) directory:

- `agent-sdk-mcp-rate-limit.ts` - Rate-limited MCP tools
- `agent-sdk-audit-log.ts` - Event logging integration
- `agent-sdk-persisted-input.ts` - Persisted message queue
- `agent-sdk-metadata-cache.ts` - Result caching
- `agent-service-http-server.ts` / `agent-service-http-client.ts` - HTTP API
- `agent-service-rpc-server.ts` / `agent-service-rpc-client.ts` - RPC API

## License

MIT
