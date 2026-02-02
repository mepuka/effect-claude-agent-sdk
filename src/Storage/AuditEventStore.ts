import * as EventLogModule from "@effect/experimental/EventLog"
import * as EventJournal from "@effect/experimental/EventJournal"
import { KeyValueStore } from "@effect/platform"
import { BunKeyValueStore } from "@effect/platform-bun"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type { HookEvent } from "../Schema/Hooks.js"
import { AuditEventSchema, layerAuditHandlers } from "../experimental/EventLog.js"
import {
  defaultAuditEventJournalKey,
  defaultAuditIdentityKey,
  defaultStorageDirectory
} from "./defaults.js"
import { StorageConfig } from "./StorageConfig.js"
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

const resolveEnabled = Effect.gen(function*() {
  const config = yield* Effect.serviceOption(StorageConfig)
  return Option.isNone(config) ? true : config.value.settings.enabled.auditLog
})

const resolveAuditKeys = (options?: {
  readonly journalKey?: string
  readonly identityKey?: string
  readonly prefix?: string
}) => ({
  journalKey:
    options?.journalKey ??
    (options?.prefix
      ? `${options.prefix}/event-journal`
      : defaultAuditEventJournalKey),
  identityKey:
    options?.identityKey ??
    (options?.prefix
      ? `${options.prefix}/event-log-identity`
      : defaultAuditIdentityKey)
})

const makeStore = Effect.gen(function*() {
  const log = yield* EventLogModule.EventLog

  const write = Effect.fn("AuditEventStore.write")((input: AuditEventInput) =>
    Effect.gen(function*() {
      const enabled = yield* resolveEnabled
      if (!enabled) return
      yield* log.write({
        schema: AuditEventSchema,
        event: input.event,
        payload: input.payload
      }).pipe(
        Effect.mapError((cause) => mapError("write", cause))
      )
    })
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
    readonly cleanup?: () => Effect.Effect<void, StorageError>
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
            key: options?.identityKey ?? defaultAuditIdentityKey
          })),
          Layer.provide(layerAuditHandlers)
        )
      )
    )

  static readonly layerFileSystem = (options?: {
    readonly directory?: string
    readonly journalKey?: string
    readonly identityKey?: string
    readonly prefix?: string
  }) =>
    AuditEventStore.layerKeyValueStore(resolveAuditKeys(options)).pipe(
      Layer.provide(
        KeyValueStore.layerFileSystem(
          options?.directory ?? defaultStorageDirectory
        )
      )
    )

  static readonly layerFileSystemBun = (options?: {
    readonly directory?: string
    readonly journalKey?: string
    readonly identityKey?: string
    readonly prefix?: string
  }) =>
    AuditEventStore.layerKeyValueStore(resolveAuditKeys(options)).pipe(
      Layer.provide(
        BunKeyValueStore.layerFileSystem(
          options?.directory ?? defaultStorageDirectory
        )
      )
    )
}
