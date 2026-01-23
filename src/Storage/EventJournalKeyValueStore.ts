import * as EventJournal from "@effect/experimental/EventJournal"
import { KeyValueStore, MsgPack } from "@effect/platform"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Schema from "effect/Schema"

const defaultKey = "claude-agent-sdk/event-journal"

const toJournalError = (method: string, cause: unknown) =>
  new EventJournal.EventJournalError({ method, cause })

const EntryArray = Schema.Array(EventJournal.Entry)
const EntryArrayMsgPack = MsgPack.schema(EntryArray)
const decodeEntries = Schema.decode(EntryArrayMsgPack)
const encodeEntries = Schema.encode(EntryArrayMsgPack)

const loadEntries = (kv: KeyValueStore.KeyValueStore, key: string) =>
  kv.getUint8Array(key).pipe(
    Effect.mapError((cause) => toJournalError("entries", cause)),
    Effect.flatMap((maybe) =>
      Option.isNone(maybe)
        ? Effect.succeed([])
        : decodeEntries(maybe.value).pipe(
            Effect.mapError((cause) => toJournalError("entries", cause))
          )
    )
  )

const persistEntries = (
  kv: KeyValueStore.KeyValueStore,
  key: string,
  entries: ReadonlyArray<EventJournal.Entry>
) =>
  encodeEntries(entries).pipe(
    Effect.mapError((cause) => toJournalError("persist", cause)),
    Effect.flatMap((payload) =>
      kv.set(key, payload).pipe(
        Effect.mapError((cause) => toJournalError("persist", cause))
      )
    )
  )

export const make = (options?: { readonly key?: string }) =>
  Effect.gen(function*() {
    const kv = yield* KeyValueStore.KeyValueStore
    const key = options?.key ?? defaultKey
    const pubsub = yield* PubSub.unbounded<EventJournal.Entry>()
    const journal = [...(yield* loadEntries(kv, key))]
    const byId = new Map(journal.map((entry) => [entry.idString, entry]))
    const remotes = new Map<string, { sequence: number; missing: Array<EventJournal.Entry> }>()

    const remoteIdToString = (remoteId: EventJournal.RemoteId) =>
      Array.from(remoteId)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")

    const ensureRemote = (remoteId: EventJournal.RemoteId) => {
      const remoteIdString = remoteIdToString(remoteId)
      let remote = remotes.get(remoteIdString)
      if (remote) return remote
      remote = { sequence: 0, missing: journal.slice() }
      remotes.set(remoteIdString, remote)
      return remote
    }

    return EventJournal.EventJournal.of({
      entries: Effect.sync(() => journal.slice()),
      write({ effect, event, payload, primaryKey }) {
        return Effect.acquireUseRelease(
          Effect.sync(() =>
            new EventJournal.Entry({
              id: EventJournal.makeEntryId(),
              event,
              primaryKey,
              payload
            }, { disableValidation: true })
          ),
          effect,
          (entry, exit) =>
            Effect.suspend(() => {
              if (exit._tag === "Failure" || byId.has(entry.idString)) return Effect.void
              journal.push(entry)
              byId.set(entry.idString, entry)
              remotes.forEach((remote) => {
                remote.missing.push(entry)
              })
              return persistEntries(kv, key, journal).pipe(
                Effect.zipRight(pubsub.publish(entry))
              )
            }).pipe(Effect.catchAll(() => Effect.void))
        )
      },
      writeFromRemote: (options) =>
        Effect.gen(function*() {
          const remote = ensureRemote(options.remoteId)
          const uncommittedRemotes: Array<EventJournal.RemoteEntry> = []
          const uncommitted: Array<EventJournal.Entry> = []
          for (const remoteEntry of options.entries) {
            if (byId.has(remoteEntry.entry.idString)) {
              if (remoteEntry.remoteSequence > remote.sequence) {
                remote.sequence = remoteEntry.remoteSequence
              }
              continue
            }
            uncommittedRemotes.push(remoteEntry)
            uncommitted.push(remoteEntry.entry)
          }

          const brackets = options.compact
            ? yield* options.compact(uncommittedRemotes)
            : [[uncommitted, uncommittedRemotes]] as const

          for (const [compacted, remoteEntries] of brackets) {
            for (const originEntry of compacted) {
              const entryMillis = EventJournal.entryIdMillis(originEntry.id)
              const conflicts: Array<EventJournal.Entry> = []
              for (let i = journal.length - 1; i >= -1; i--) {
                const entry = journal[i]
                if (entry !== undefined && entry.createdAtMillis > entryMillis) {
                  continue
                }
                for (let j = i + 2; j < journal.length; j++) {
                  const check = journal[j]!
                  if (check.event === originEntry.event && check.primaryKey === originEntry.primaryKey) {
                    conflicts.push(check)
                  }
                }
                yield* options.effect({ entry: originEntry, conflicts })
                break
              }
            }
            for (const remoteEntry of remoteEntries) {
              journal.push(remoteEntry.entry)
              if (remoteEntry.remoteSequence > remote.sequence) {
                remote.sequence = remoteEntry.remoteSequence
              }
            }
            journal.sort((a, b) => a.createdAtMillis - b.createdAtMillis)
          }

          yield* persistEntries(kv, key, journal)
        }),
      withRemoteUncommited: (remoteId, f) =>
        Effect.acquireUseRelease(
          Effect.sync(() => ensureRemote(remoteId).missing.slice()),
          f,
          (entries, exit) =>
            Effect.sync(() => {
              if (exit._tag === "Failure") return
              const last = entries[entries.length - 1]
              if (!last) return
              const remote = ensureRemote(remoteId)
              for (let i = remote.missing.length - 1; i >= 0; i--) {
                const missing = remote.missing[i]
                if (missing && missing.id === last.id) {
                  remote.missing = remote.missing.slice(i + 1)
                  break
                }
              }
            })
        ),
      nextRemoteSequence: (remoteId) =>
        Effect.sync(() => ensureRemote(remoteId).sequence),
      changes: PubSub.subscribe(pubsub),
      destroy: kv.remove(key).pipe(
        Effect.mapError((cause) => toJournalError("destroy", cause)),
        Effect.tap(() =>
          Effect.sync(() => {
            journal.length = 0
            byId.clear()
            remotes.clear()
          })
        )
      )
    })
  })

export const layerKeyValueStore = (options?: { readonly key?: string }) =>
  Layer.scoped(EventJournal.EventJournal, make(options))
