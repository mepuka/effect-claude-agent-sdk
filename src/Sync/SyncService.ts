import * as EventLogModule from "@effect/experimental/EventLog"
import * as EventLogEncryption from "@effect/experimental/EventLogEncryption"
import * as EventLogRemote from "@effect/experimental/EventLogRemote"
import * as Socket from "@effect/platform/Socket"
import { BunSocket } from "@effect/platform-bun"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as FiberMap from "effect/FiberMap"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import { StorageConfig } from "../Storage/StorageConfig.js"

export type RemoteStatus = {
  readonly remoteId: string
  readonly connected: boolean
  readonly lastSyncAt?: number
  readonly lastError?: string
}

const remoteIdToString = (remoteId: Uint8Array) =>
  Array.from(remoteId)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

export class SyncService extends Context.Tag("@effect/claude-agent-sdk/SyncService")<
  SyncService,
  {
    readonly connect: (remote: EventLogRemote.EventLogRemote) => Effect.Effect<void>
    readonly connectWebSocket: (url: string, options?: { disablePing?: boolean }) => Effect.Effect<void>
    readonly disconnect: (remoteId: string) => Effect.Effect<void>
    readonly syncNow: () => Effect.Effect<void>
    readonly status: () => Effect.Effect<ReadonlyArray<RemoteStatus>>
  }
>() {
  static readonly layer = Layer.scoped(SyncService, make())

  static readonly layerWebSocket = (
    url: string,
    options?: { disablePing?: boolean }
  ) =>
    Layer.scoped(SyncService, makeWithWebSocket(url, options)).pipe(
      Layer.provide(BunSocket.layerWebSocketConstructor),
      Layer.provide(EventLogEncryption.layerSubtle)
    )
}

function makeWithWebSocket(
  url: string,
  options?: { disablePing?: boolean }
) {
  return Effect.gen(function*() {
    const service = yield* make()
    yield* service.connectWebSocket(url, options)
    return service
  })
}

function make() {
  return Effect.gen(function*() {
    const scope = yield* Effect.scope
    const log = yield* EventLogModule.EventLog
    const encryption = yield* EventLogEncryption.EventLogEncryption
    const webSocketConstructor = yield* Socket.WebSocketConstructor
    const fibers = yield* FiberMap.make<string>()
    const statusRef = yield* Ref.make<Map<string, RemoteStatus>>(new Map())
    const connectorsRef = yield* Ref.make<
      Map<string, Effect.Effect<void, never, Scope.Scope>>
    >(new Map())

    const setStatus = (status: RemoteStatus) =>
      Ref.update(statusRef, (map) => {
        const next = new Map(map)
        next.set(status.remoteId, status)
        return next
      })

    const markConnected = (remoteId: string) =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        yield* setStatus({
          remoteId,
          connected: true,
          lastSyncAt: now
        })
      })

    const markDisconnected = (remoteId: string, error?: string) =>
      Ref.update(statusRef, (map) => {
        const next = new Map(map)
        const previous = next.get(remoteId)
        const lastSyncAt = previous?.lastSyncAt
        const lastError = error ?? previous?.lastError
        const status: RemoteStatus = {
          remoteId,
          connected: false,
          ...(lastSyncAt !== undefined ? { lastSyncAt } : {}),
          ...(lastError !== undefined ? { lastError } : {})
        }
        next.set(remoteId, status)
        return next
      })

    const runTracked = <R>(key: string, effect: Effect.Effect<void, never, R>) =>
      FiberMap.run(
        fibers,
        key,
        Scope.extend(
          effect.pipe(
            Effect.catchAllCause((cause) => markDisconnected(key, Cause.pretty(cause))),
            Effect.ensuring(markDisconnected(key))
          ),
          scope
        ),
        { onlyIfMissing: true }
      )

    const registerConnector = (key: string, effect: Effect.Effect<void, never, Scope.Scope>) =>
      Ref.update(connectorsRef, (map) => {
        const next = new Map(map)
        next.set(key, effect)
        return next
      })

    const removeConnector = (key: string) =>
      Ref.update(connectorsRef, (map) => {
        const next = new Map(map)
        next.delete(key)
        return next
      })

    const connectInternal = Effect.fn("SyncService.connectInternal")(function*(
      key: string,
      effect: Effect.Effect<void, never, Scope.Scope>
    ) {
      yield* registerConnector(key, effect)
      yield* markConnected(key)
      yield* runTracked(key, effect)
    })

    const connect = Effect.fn("SyncService.connect")(function*(
      remote: EventLogRemote.EventLogRemote
    ) {
      const key = remoteIdToString(remote.id)
      yield* connectInternal(key, log.registerRemote(remote))
    })

    const connectWebSocket = Effect.fn("SyncService.connectWebSocket")(function*(
      url: string,
      options?: { disablePing?: boolean }
    ) {
      const effect = EventLogRemote.fromWebSocket(url, options).pipe(
        Effect.provideService(EventLogModule.EventLog, log),
        Effect.provideService(EventLogEncryption.EventLogEncryption, encryption),
        Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor)
      )
      yield* connectInternal(url, effect)
    })

    const disconnect = Effect.fn("SyncService.disconnect")((remoteId: string) =>
      FiberMap.remove(fibers, remoteId).pipe(
        Effect.zipRight(removeConnector(remoteId)),
        Effect.zipRight(markDisconnected(remoteId))
      )
    )

    const syncNow = Effect.fn("SyncService.syncNow")(function*() {
      const connectors = yield* Ref.get(connectorsRef)
      if (connectors.size === 0) return
      yield* Effect.forEach(
        connectors,
        ([key, effect]) =>
          FiberMap.remove(fibers, key).pipe(
            Effect.zipRight(markConnected(key)),
            Effect.zipRight(runTracked(key, effect))
          ),
        { discard: true }
      )
    })

    const status = Effect.fn("SyncService.status")(() =>
      Ref.get(statusRef).pipe(
        Effect.map((map) => Array.from(map.values()))
      )
    )

    yield* Effect.gen(function*() {
      const config = yield* Effect.serviceOption(StorageConfig)
      if (Option.isNone(config)) return
      const interval = config.value.settings.sync.interval
      if (Duration.toMillis(interval) <= 0) return
      yield* Effect.repeat(syncNow(), Schedule.spaced(interval))
    }).pipe(
      Effect.catchAllCause(Effect.logDebug),
      Effect.forkScoped
    )

    return SyncService.of({
      connect,
      connectWebSocket,
      disconnect,
      syncNow,
      status
    })
  })
}
