import { KeyValueStore } from "@effect/platform"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as SynchronizedRef from "effect/SynchronizedRef"
import * as Schema from "effect/Schema"
import type { SDKMessage } from "../Schema/Message.js"
import { ChatEvent, ChatEventSource } from "../Schema/Storage.js"
import { StorageError, toStorageError } from "./StorageError.js"

export type ChatHistoryAppendOptions = {
  readonly timestamp?: number
  readonly source?: ChatEventSource
}

export type ChatHistoryListOptions = {
  readonly startSequence?: number
  readonly endSequence?: number
  readonly limit?: number
  readonly reverse?: boolean
}

const defaultSource: ChatEventSource = "sdk"

const ChatMeta = Schema.Struct({
  lastSequence: Schema.Number,
  updatedAt: Schema.Number
})

type ChatMeta = typeof ChatMeta.Type

type SessionState = {
  readonly lastSequence: number
  readonly events: ReadonlyArray<ChatEvent>
}

const emptySessionState: SessionState = {
  lastSequence: 0,
  events: []
}

const makeEvent = (
  sessionId: string,
  sequence: number,
  timestamp: number,
  source: ChatEventSource,
  message: SDKMessage
) =>
  ChatEvent.make({
    sessionId,
    sequence,
    timestamp,
    source,
    message
  })

const range = (start: number, end: number, reverse: boolean, limit: number) => {
  const values: number[] = []
  if (limit <= 0) return values
  if (reverse) {
    for (let current = end; current >= start; current -= 1) {
      values.push(current)
      if (values.length >= limit) break
    }
    return values
  }
  for (let current = start; current <= end; current += 1) {
    values.push(current)
    if (values.length >= limit) break
  }
  return values
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

const normalizeRange = (
  lastSequence: number,
  options?: ChatHistoryListOptions
) => {
  if (lastSequence <= 0) {
    return {
      start: 1,
      end: 0,
      limit: 0,
      reverse: options?.reverse ?? false
    }
  }

  const startInput = options?.startSequence ?? 1
  const endInput = options?.endSequence ?? lastSequence
  const start = clamp(startInput, 1, lastSequence)
  const end = clamp(endInput, 1, lastSequence)
  const reverse = options?.reverse ?? false
  const orderedStart = reverse ? Math.min(start, end) : Math.min(start, end)
  const orderedEnd = reverse ? Math.max(start, end) : Math.max(start, end)
  const total = orderedEnd - orderedStart + 1
  const limit = options?.limit ? Math.min(total, options.limit) : total

  return {
    start: orderedStart,
    end: orderedEnd,
    limit,
    reverse
  }
}

const storeName = "ChatHistoryStore"

export class ChatHistoryStore extends Context.Tag("@effect/claude-agent-sdk/ChatHistoryStore")<
  ChatHistoryStore,
  {
    readonly appendMessage: (
      sessionId: string,
      message: SDKMessage,
      options?: ChatHistoryAppendOptions
    ) => Effect.Effect<ChatEvent, StorageError>
    readonly appendMessages: (
      sessionId: string,
      messages: Iterable<SDKMessage>,
      options?: ChatHistoryAppendOptions
    ) => Effect.Effect<ReadonlyArray<ChatEvent>, StorageError>
    readonly list: (
      sessionId: string,
      options?: ChatHistoryListOptions
    ) => Effect.Effect<ReadonlyArray<ChatEvent>, StorageError>
    readonly stream: (
      sessionId: string,
      options?: ChatHistoryListOptions
    ) => Stream.Stream<ChatEvent, StorageError>
    readonly purge: (sessionId: string) => Effect.Effect<void, StorageError>
  }
>() {
  static readonly layerMemory = Layer.effect(
    ChatHistoryStore,
    Effect.gen(function*() {
      const stateRef = yield* SynchronizedRef.make(new Map<string, SessionState>())

      const appendMessage = Effect.fn("ChatHistoryStore.appendMessage")(
        function*(sessionId: string, message: SDKMessage, options?: ChatHistoryAppendOptions) {
          const timestamp = options?.timestamp ?? (yield* Clock.currentTimeMillis)
          const source = options?.source ?? defaultSource
          return yield* SynchronizedRef.modify(stateRef, (state) => {
            const next = new Map(state)
            const session = next.get(sessionId) ?? emptySessionState
            const sequence = session.lastSequence + 1
            const event = makeEvent(sessionId, sequence, timestamp, source, message)
            const events = session.events.concat(event)
            next.set(sessionId, { lastSequence: sequence, events })
            return [event, next] as const
          })
        }
      )

      const appendMessages = Effect.fn("ChatHistoryStore.appendMessages")(
        function*(sessionId: string, messages: Iterable<SDKMessage>, options?: ChatHistoryAppendOptions) {
          const timestamp = options?.timestamp ?? (yield* Clock.currentTimeMillis)
          const source = options?.source ?? defaultSource
          const batch = Array.from(messages)
          if (batch.length === 0) return []

          return yield* SynchronizedRef.modify(stateRef, (state) => {
            const next = new Map(state)
            const session = next.get(sessionId) ?? emptySessionState
            const startSequence = session.lastSequence
            const events = batch.map((message, index) =>
              makeEvent(sessionId, startSequence + index + 1, timestamp, source, message)
            )
            const updated = session.events.concat(events)
            next.set(sessionId, {
              lastSequence: startSequence + events.length,
              events: updated
            })
            return [events, next] as const
          })
        }
      )

      const list = Effect.fn("ChatHistoryStore.list")(function*(
        sessionId: string,
        options?: ChatHistoryListOptions
      ) {
        const state = yield* SynchronizedRef.get(stateRef)
        const session = state.get(sessionId)
        if (!session) return []
        const { start, end, limit, reverse } = normalizeRange(session.lastSequence, options)
        if (limit <= 0) return []
        let events = session.events.filter((event) => event.sequence >= start && event.sequence <= end)
        if (reverse) events = events.slice().reverse()
        if (limit < events.length) events = events.slice(0, limit)
        return events
      })

      const stream = (sessionId: string, options?: ChatHistoryListOptions) =>
        Stream.unwrap(list(sessionId, options).pipe(Effect.map(Stream.fromIterable)))

      const purge = Effect.fn("ChatHistoryStore.purge")((sessionId: string) =>
        SynchronizedRef.update(stateRef, (state) => {
          const next = new Map(state)
          next.delete(sessionId)
          return next
        })
      )

      return ChatHistoryStore.of({
        appendMessage,
        appendMessages,
        list,
        stream,
        purge
      })
    })
  )

  static readonly layerKeyValueStore = (options?: { readonly prefix?: string }) =>
    Layer.effect(
      ChatHistoryStore,
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        const prefix = options?.prefix ?? "claude-agent-sdk/chat-history"
        const eventStore = kv.forSchema(ChatEvent)
        const metaStore = kv.forSchema(ChatMeta)

        const metaKey = (sessionId: string) => `${prefix}/${sessionId}/meta`
        const eventKey = (sessionId: string, sequence: number) =>
          `${prefix}/${sessionId}/event/${sequence}`

        const loadMeta = (sessionId: string) =>
          metaStore.get(metaKey(sessionId)).pipe(
            Effect.mapError((cause) =>
              toStorageError(storeName, "loadMeta", cause)
            ),
            Effect.map((maybe) => Option.getOrElse(maybe, () => ({
              lastSequence: 0,
              updatedAt: 0
            } satisfies ChatMeta)))
          )

        const saveMeta = (sessionId: string, meta: ChatMeta) =>
          metaStore.set(metaKey(sessionId), meta).pipe(
            Effect.mapError((cause) =>
              toStorageError(storeName, "saveMeta", cause)
            )
          )

        const appendMessage = Effect.fn("ChatHistoryStore.appendMessage")(
          function*(sessionId: string, message: SDKMessage, options?: ChatHistoryAppendOptions) {
            const timestamp = options?.timestamp ?? (yield* Clock.currentTimeMillis)
            const source = options?.source ?? defaultSource
            const meta = yield* loadMeta(sessionId)
            const sequence = meta.lastSequence + 1
            const event = makeEvent(sessionId, sequence, timestamp, source, message)
            yield* eventStore.set(eventKey(sessionId, sequence), event).pipe(
              Effect.mapError((cause) =>
                toStorageError(storeName, "appendMessage", cause)
              )
            )
            yield* saveMeta(sessionId, { lastSequence: sequence, updatedAt: timestamp })
            return event
          }
        )

        const appendMessages = Effect.fn("ChatHistoryStore.appendMessages")(
          function*(sessionId: string, messages: Iterable<SDKMessage>, options?: ChatHistoryAppendOptions) {
            const timestamp = options?.timestamp ?? (yield* Clock.currentTimeMillis)
            const source = options?.source ?? defaultSource
            const batch = Array.from(messages)
            if (batch.length === 0) return []

            const meta = yield* loadMeta(sessionId)
            const events = batch.map((message, index) =>
              makeEvent(sessionId, meta.lastSequence + index + 1, timestamp, source, message)
            )

            yield* Effect.forEach(
              events,
              (event) =>
                eventStore.set(eventKey(sessionId, event.sequence), event).pipe(
                  Effect.mapError((cause) =>
                    toStorageError(storeName, "appendMessages", cause)
                  )
                ),
              { discard: true }
            )

            yield* saveMeta(sessionId, {
              lastSequence: meta.lastSequence + events.length,
              updatedAt: timestamp
            })

            return events
          }
        )

        const list = Effect.fn("ChatHistoryStore.list")(function*(
          sessionId: string,
          options?: ChatHistoryListOptions
        ) {
          const metaOption = yield* metaStore.get(metaKey(sessionId)).pipe(
            Effect.mapError((cause) =>
              toStorageError(storeName, "list", cause)
            )
          )
          if (Option.isNone(metaOption)) return []

          const meta = metaOption.value
          const { start, end, limit, reverse } = normalizeRange(meta.lastSequence, options)
          if (limit <= 0) return []
          const sequences = range(start, end, reverse, limit)

          const events = yield* Effect.forEach(
            sequences,
            (sequence) =>
              eventStore.get(eventKey(sessionId, sequence)).pipe(
                Effect.mapError((cause) =>
                  toStorageError(storeName, "list", cause)
                )
              ),
            { discard: false }
          )

          return events.flatMap((eventOption) =>
            Option.isSome(eventOption) ? [eventOption.value] : []
          )
        })

        const stream = (sessionId: string, options?: ChatHistoryListOptions) =>
          Stream.unwrap(list(sessionId, options).pipe(Effect.map(Stream.fromIterable)))

        const purge = Effect.fn("ChatHistoryStore.purge")((sessionId: string) =>
          Effect.gen(function*() {
            const metaOption = yield* metaStore.get(metaKey(sessionId)).pipe(
              Effect.mapError((cause) =>
                toStorageError(storeName, "purge", cause)
              )
            )
            if (Option.isNone(metaOption)) return

            const lastSequence = metaOption.value.lastSequence
            const sequences = range(1, lastSequence, false, lastSequence)
            yield* Effect.forEach(
              sequences,
              (sequence) =>
                eventStore.remove(eventKey(sessionId, sequence)).pipe(
                  Effect.mapError((cause) =>
                    toStorageError(storeName, "purge", cause)
                  )
                ),
              { discard: true }
            )
            yield* metaStore.remove(metaKey(sessionId)).pipe(
              Effect.mapError((cause) =>
                toStorageError(storeName, "purge", cause)
              )
            )
          })
        )

        return ChatHistoryStore.of({
          appendMessage,
          appendMessages,
          list,
          stream,
          purge
        })
      })
    )
}
