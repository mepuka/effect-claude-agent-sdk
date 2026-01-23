import * as EventLogModule from "@effect/experimental/EventLog"
import * as EventJournal from "@effect/experimental/EventJournal"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { HookEvent } from "../Schema/Hooks.js"
import { AuditEventSchema, layerAuditHandlers } from "../experimental/EventLog.js"
import { StorageError, toStorageError } from "./StorageError.js"
import { layerKeyValueStore as layerEventJournalKeyValueStore } from "./EventJournalKeyValueStore.js"

export type AuditEventInput =
  | {
      readonly event: "tool_use"
      readonly payload: {
        readonly sessionId: string
        readonly toolName: string
        readonly toolUseId?: string
        readonly status: "start" | "success" | "failure"
        readonly durationMs?: number
      }
    }
  | {
      readonly event: "permission_decision"
      readonly payload: {
        readonly sessionId: string
        readonly toolName: string
        readonly decision: "allow" | "deny" | "prompt"
        readonly reason?: string
      }
    }
  | {
      readonly event: "hook_event"
      readonly payload: {
        readonly sessionId?: string
        readonly hook: HookEvent
        readonly toolUseId?: string
        readonly outcome: "success" | "failure"
      }
    }

const storeName = "AuditEventStore"

const mapError = (operation: string, cause: unknown) =>
  toStorageError(storeName, operation, cause)

const makeStore = Effect.gen(function*() {
  const log = yield* EventLogModule.EventLog

  const write = Effect.fn("AuditEventStore.write")((input: AuditEventInput) =>
    log.write({
      schema: AuditEventSchema,
      event: input.event,
      payload: input.payload
    }).pipe(
      Effect.mapError((cause) => mapError("write", cause))
    )
  )

  const entries = log.entries.pipe(
    Effect.mapError((cause) => mapError("entries", cause))
  )

  return AuditEventStore.of({ write, entries })
})

export class AuditEventStore extends Context.Tag("@effect/claude-agent-sdk/AuditEventStore")<
  AuditEventStore,
  {
    readonly write: (input: AuditEventInput) => Effect.Effect<void, StorageError>
    readonly entries: Effect.Effect<ReadonlyArray<EventJournal.Entry>, StorageError>
  }
>() {
  static readonly layerMemory = Layer.effect(
    AuditEventStore,
    makeStore
  ).pipe(
    Layer.provide(
      EventLogModule.layerEventLog.pipe(
        Layer.provide(EventJournal.layerMemory),
        Layer.provide(Layer.sync(EventLogModule.Identity, () => EventLogModule.Identity.makeRandom())),
        Layer.provide(layerAuditHandlers)
      )
    )
  )

  static readonly layerKeyValueStore = (options?: {
    readonly journalKey?: string
    readonly identityKey?: string
  }) =>
    Layer.effect(AuditEventStore, makeStore).pipe(
      Layer.provide(
        EventLogModule.layerEventLog.pipe(
          Layer.provide(
            layerEventJournalKeyValueStore(
              options?.journalKey ? { key: options.journalKey } : undefined
            )
          ),
          Layer.provide(EventLogModule.layerIdentityKvs({
            key: options?.identityKey ?? "claude-agent-sdk/event-log-identity"
          })),
          Layer.provide(layerAuditHandlers)
        )
      )
    )
}
