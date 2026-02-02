import { expect, test } from "bun:test"
import { KeyValueStore } from "@effect/platform"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { runEffectLive } from "./effect-test.js"
import { Storage, Sync } from "../src/index.js"
import { makeUserMessage } from "../src/internal/messages.js"

const canListen = async () => {
  const maxAttempts = 5
  const minPort = 20000
  const maxPort = 45000

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = minPort + Math.floor(Math.random() * (maxPort - minPort))
    try {
      const server = Bun.serve({ port, fetch: () => new Response("ok") })
      server.stop(true)
      return true
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        const code = (error as { code?: string }).code
        if (code === "EADDRINUSE") continue
        if (code === "EPERM") return false
      }
      return false
    }
  }

  return false
}

const waitFor = <A, E>(
  label: string,
  effect: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  options?: {
    readonly retries?: number
    readonly interval?: Duration.DurationInput
  }
) =>
  Effect.gen(function*() {
    const retries = options?.retries ?? 40
    const interval = options?.interval ?? Duration.millis(25)
    for (let attempt = 0; attempt < retries; attempt += 1) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.sleep(interval)
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${label}.`))
  })

const makeReplicaLayer = (url: string) => {
  const baseLayer = Storage.ChatHistoryStore.layerJournaledWithEventLog()
  const syncLayer = Sync.SyncService.layerWebSocket(url, { disablePing: true }).pipe(
    Layer.provide(baseLayer)
  )
  return Layer.merge(baseLayer, syncLayer).pipe(
    Layer.provide(Layer.fresh(KeyValueStore.layerMemory))
  )
}

test("Remote sync converges and resumes after reconnect", async () => {
  if (!(await canListen())) return
  const program = Effect.scoped(
    Effect.gen(function*() {
      const server = yield* Sync.EventLogRemoteServer
      const replicaAContext = yield* Layer.build(makeReplicaLayer(server.url))
      const replicaBContext = yield* Layer.build(makeReplicaLayer(server.url))

      const storeA = Context.get(replicaAContext, Storage.ChatHistoryStore)
      const storeB = Context.get(replicaBContext, Storage.ChatHistoryStore)
      const syncA = Context.get(replicaAContext, Sync.SyncService)

      const firstMessage = makeUserMessage("hello")
      yield* storeA.appendMessage("session-1", firstMessage)

      const listB = yield* waitFor(
        "replica B to receive first message",
        storeB.list("session-1"),
        (list) => list.length === 1
      )

      yield* syncA.disconnect(server.url)

      const secondMessage = makeUserMessage("hello again")
      yield* storeB.appendMessage("session-1", secondMessage)

      yield* syncA.connectWebSocket(server.url, { disablePing: true })

      const listA = yield* waitFor(
        "replica A to receive second message",
        storeA.list("session-1"),
        (list) => list.length === 2
      )

      return { listA, listB }
    }).pipe(
      Effect.provide(Sync.layerBunWebSocketTest())
    )
  )

  const result = await runEffectLive(program)
  expect(result.listB).toHaveLength(1)
  expect(result.listA.map((event) => event.sequence)).toEqual([1, 2])
})
