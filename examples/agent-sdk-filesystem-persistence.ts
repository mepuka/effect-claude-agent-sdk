import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { AgentRuntime, Storage } from "../src/index.js"

const storageDir = "/storage"
const storageLayers = Storage.layersFileSystemBun({ directory: storageDir })

const program = Effect.scoped(
  Effect.gen(function*() {
    const runtime = yield* AgentRuntime
    const handle = yield* runtime.query("Summarize the current repository.")
    yield* handle.stream.pipe(Stream.runDrain)
  }).pipe(
    Effect.provide(
      AgentRuntime.layerWithPersistence({
        layers: {
          runtime: AgentRuntime.layerDefaultFromEnv().pipe(Layer.orDie),
          chatHistory: storageLayers.chatHistory.pipe(Layer.orDie),
          artifacts: storageLayers.artifacts.pipe(Layer.orDie),
          auditLog: storageLayers.auditLog.pipe(Layer.orDie),
          sessionIndex: storageLayers.sessionIndex.pipe(Layer.orDie)
        }
      })
    )
  )
)

Effect.runPromise(program)
