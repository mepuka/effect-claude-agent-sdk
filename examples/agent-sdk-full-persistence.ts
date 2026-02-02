import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { AgentRuntime } from "../src/index.js"

const program = Effect.scoped(
  Effect.gen(function*() {
    const runtime = yield* AgentRuntime
    const handle = yield* runtime.query("Summarize the current repository.")
    yield* handle.stream.pipe(Stream.runDrain)
  }).pipe(
    Effect.provide(
      AgentRuntime.layerWithPersistence({
        layers: {
          runtime: AgentRuntime.layerDefaultFromEnv().pipe(Layer.orDie)
        }
      })
    )
  )
)

Effect.runPromise(program)
