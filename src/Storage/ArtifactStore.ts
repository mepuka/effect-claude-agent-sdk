import { KeyValueStore } from "@effect/platform"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as SynchronizedRef from "effect/SynchronizedRef"
import { ArtifactRecord } from "../Schema/Storage.js"
import { StorageError, toStorageError } from "./StorageError.js"

export type ArtifactListOptions = {
  readonly offset?: number
  readonly limit?: number
}

const storeName = "ArtifactStore"

const ArtifactIndex = Schema.Struct({
  ids: Schema.Array(Schema.String),
  updatedAt: Schema.Number
})

type ArtifactIndex = typeof ArtifactIndex.Type

type ArtifactState = {
  readonly byId: Map<string, ArtifactRecord>
  readonly bySession: Map<string, ReadonlyArray<string>>
}

const emptyState: ArtifactState = {
  byId: new Map(),
  bySession: new Map()
}

const updateIndex = (ids: ReadonlyArray<string>, id: string) => {
  if (ids.includes(id)) return ids
  return ids.concat(id)
}

export class ArtifactStore extends Context.Tag("@effect/claude-agent-sdk/ArtifactStore")<
  ArtifactStore,
  {
    readonly put: (record: ArtifactRecord) => Effect.Effect<void, StorageError>
    readonly get: (id: string) => Effect.Effect<Option.Option<ArtifactRecord>, StorageError>
    readonly list: (
      sessionId: string,
      options?: ArtifactListOptions
    ) => Effect.Effect<ReadonlyArray<ArtifactRecord>, StorageError>
    readonly delete: (id: string) => Effect.Effect<void, StorageError>
    readonly purgeSession: (sessionId: string) => Effect.Effect<void, StorageError>
  }
>() {
  static readonly layerMemory = Layer.effect(
    ArtifactStore,
    Effect.gen(function*() {
      const stateRef = yield* SynchronizedRef.make(emptyState)

      const put = Effect.fn("ArtifactStore.put")((record: ArtifactRecord) =>
        SynchronizedRef.update(stateRef, (state) => {
          const next: ArtifactState = {
            byId: new Map(state.byId),
            bySession: new Map(state.bySession)
          }
          next.byId.set(record.id, record)
          const currentIds = next.bySession.get(record.sessionId) ?? []
          next.bySession.set(record.sessionId, updateIndex(currentIds, record.id))
          return next
        }).pipe(Effect.asVoid)
      )

      const get = Effect.fn("ArtifactStore.get")((id: string) =>
        SynchronizedRef.get(stateRef).pipe(
          Effect.map((state) => Option.fromNullable(state.byId.get(id)))
        )
      )

      const list = Effect.fn("ArtifactStore.list")((sessionId: string, options?: ArtifactListOptions) =>
        SynchronizedRef.get(stateRef).pipe(
          Effect.map((state) => {
            const ids = state.bySession.get(sessionId) ?? []
            const offset = Math.max(0, options?.offset ?? 0)
            const limit = options?.limit
            const slice = limit === undefined ? ids.slice(offset) : ids.slice(offset, offset + limit)
            return slice.flatMap((id) => {
              const record = state.byId.get(id)
              return record ? [record] : []
            })
          })
        )
      )

      const deleteArtifact = Effect.fn("ArtifactStore.delete")((id: string) =>
        SynchronizedRef.update(stateRef, (state) => {
          const record = state.byId.get(id)
          if (!record) return state
          const next: ArtifactState = {
            byId: new Map(state.byId),
            bySession: new Map(state.bySession)
          }
          next.byId.delete(id)
          const ids = next.bySession.get(record.sessionId) ?? []
          next.bySession.set(
            record.sessionId,
            ids.filter((existing) => existing !== id)
          )
          return next
        })
      )

      const purgeSession = Effect.fn("ArtifactStore.purgeSession")((sessionId: string) =>
        SynchronizedRef.update(stateRef, (state) => {
          const ids = state.bySession.get(sessionId) ?? []
          const next: ArtifactState = {
            byId: new Map(state.byId),
            bySession: new Map(state.bySession)
          }
          for (const id of ids) {
            next.byId.delete(id)
          }
          next.bySession.delete(sessionId)
          return next
        })
      )

      return ArtifactStore.of({
        put,
        get,
        list,
        delete: deleteArtifact,
        purgeSession
      })
    })
  )

  static readonly layerKeyValueStore = (options?: { readonly prefix?: string }) =>
    Layer.effect(
      ArtifactStore,
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        const prefix = options?.prefix ?? "claude-agent-sdk/artifacts"
        const recordStore = kv.forSchema(ArtifactRecord)
        const indexStore = kv.forSchema(ArtifactIndex)

        const recordKey = (id: string) => `${prefix}/by-id/${id}`
        const indexKey = (sessionId: string) => `${prefix}/by-session/${sessionId}`

        const loadIndex = (sessionId: string) =>
          indexStore.get(indexKey(sessionId)).pipe(
            Effect.mapError((cause) => toStorageError(storeName, "loadIndex", cause)),
            Effect.map((maybe) =>
              Option.getOrElse(maybe, () => ({
                ids: [],
                updatedAt: 0
              } satisfies ArtifactIndex))
            )
          )

        const saveIndex = (sessionId: string, index: ArtifactIndex) =>
          indexStore.set(indexKey(sessionId), index).pipe(
            Effect.mapError((cause) => toStorageError(storeName, "saveIndex", cause))
          )

        const put = Effect.fn("ArtifactStore.put")((record: ArtifactRecord) =>
          Effect.gen(function*() {
            const now = yield* Clock.currentTimeMillis
            yield* recordStore.set(recordKey(record.id), record).pipe(
              Effect.mapError((cause) => toStorageError(storeName, "put", cause))
            )
            const index = yield* loadIndex(record.sessionId)
            const ids = updateIndex(index.ids, record.id)
            yield* saveIndex(record.sessionId, { ids, updatedAt: now })
          })
        )

        const get = Effect.fn("ArtifactStore.get")((id: string) =>
          recordStore.get(recordKey(id)).pipe(
            Effect.mapError((cause) => toStorageError(storeName, "get", cause))
          )
        )

        const list = Effect.fn("ArtifactStore.list")((sessionId: string, options?: ArtifactListOptions) =>
          Effect.gen(function*() {
            const indexOption = yield* indexStore.get(indexKey(sessionId)).pipe(
              Effect.mapError((cause) => toStorageError(storeName, "list", cause))
            )
            if (Option.isNone(indexOption)) return []
            const offset = Math.max(0, options?.offset ?? 0)
            const limit = options?.limit
            const ids = indexOption.value.ids
            const slice = limit === undefined ? ids.slice(offset) : ids.slice(offset, offset + limit)
            const records = yield* Effect.forEach(
              slice,
              (id) => recordStore.get(recordKey(id)).pipe(
                Effect.mapError((cause) => toStorageError(storeName, "list", cause))
              ),
              { discard: false }
            )
            return records.flatMap((record) => Option.isSome(record) ? [record.value] : [])
          })
        )

        const deleteArtifact = Effect.fn("ArtifactStore.delete")((id: string) =>
          Effect.gen(function*() {
            const recordOption = yield* recordStore.get(recordKey(id)).pipe(
              Effect.mapError((cause) => toStorageError(storeName, "delete", cause))
            )
            if (Option.isNone(recordOption)) return
            const record = recordOption.value
            yield* recordStore.remove(recordKey(id)).pipe(
              Effect.mapError((cause) => toStorageError(storeName, "delete", cause))
            )
            const index = yield* loadIndex(record.sessionId)
            const ids = index.ids.filter((existing) => existing !== id)
            yield* saveIndex(record.sessionId, { ids, updatedAt: index.updatedAt })
          })
        )

        const purgeSession = Effect.fn("ArtifactStore.purgeSession")((sessionId: string) =>
          Effect.gen(function*() {
            const indexOption = yield* indexStore.get(indexKey(sessionId)).pipe(
              Effect.mapError((cause) => toStorageError(storeName, "purgeSession", cause))
            )
            if (Option.isNone(indexOption)) return
            const ids = indexOption.value.ids
            yield* Effect.forEach(
              ids,
              (id) => recordStore.remove(recordKey(id)).pipe(
                Effect.mapError((cause) => toStorageError(storeName, "purgeSession", cause))
              ),
              { discard: true }
            )
            yield* indexStore.remove(indexKey(sessionId)).pipe(
              Effect.mapError((cause) => toStorageError(storeName, "purgeSession", cause))
            )
          })
        )

        return ArtifactStore.of({
          put,
          get,
          list,
          delete: deleteArtifact,
          purgeSession
        })
      })
    )
}
