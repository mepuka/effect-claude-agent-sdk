# effect-claude-agent-sdk

## Install

```bash
bun install
```

## Experimental Features

### Rate-limit Tool Handlers

```ts
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Experimental, Tools } from "effect-claude-agent-sdk"

const Echo = Tools.Tool.make("echo", {
  parameters: { text: Schema.String },
  success: Schema.String
})

const handlers = {
  echo: ({ text }: { readonly text: string }) => Effect.succeed(text)
}

const limited = Experimental.RateLimiter.rateLimitHandlers(
  handlers,
  { limit: 5, window: "1 minute" },
  { keyPrefix: "tools" }
)

const program = limited.echo({ text: "hello" }).pipe(
  Effect.provide(Experimental.RateLimiter.layerMemory)
)

Effect.runPromise(program)
```

### Persisted Input Queue

```ts
import * as Effect from "effect/Effect"
import { Experimental, Schema } from "effect-claude-agent-sdk"

const program = Effect.gen(function*() {
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

Effect.runPromise(program)
```

### Audit Event Log

```ts
import * as Effect from "effect/Effect"
import { Experimental } from "effect-claude-agent-sdk"

const program = Effect.scoped(
  Effect.gen(function*() {
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
    Effect.provide([Experimental.EventLog.layerMemory, Experimental.EventLog.layerAuditHandlers])
  )
)

Effect.runPromise(program)
```

## Examples

- `examples/experimental-rate-limit.ts`
- `examples/experimental-persisted-queue.ts`
- `examples/experimental-audit-log.ts`
- `examples/agent-sdk-audit-log.ts`
- `examples/agent-sdk-persisted-input.ts`
- `examples/agent-sdk-metadata-cache.ts`
- `examples/agent-sdk-mcp-rate-limit.ts`

This project was created using `bun init` in bun v1.3.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
