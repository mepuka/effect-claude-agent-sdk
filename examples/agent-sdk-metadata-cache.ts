import * as Effect from "effect/Effect"
import { AgentSdk, Experimental } from "../src/index.js"

const program = Effect.scoped(
  Effect.gen(function*() {
    const sdk = yield* AgentSdk
    const handle = yield* sdk.query("List the supported slash commands.")
    const cached = yield* Experimental.PersistedCache.makeCachedQueryHandle(handle, {
      timeToLive: "1 minute"
    })

    const commands = yield* cached.supportedCommands
    yield* Effect.log(commands)
    yield* handle.interrupt
  }).pipe(
    Effect.provide([
      AgentSdk.layerDefaultFromEnv(),
      Experimental.PersistedCache.Persistence.layerResultMemory
    ])
  )
)

Effect.runPromise(program)
