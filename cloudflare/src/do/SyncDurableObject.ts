/// <reference types="@cloudflare/workers-types" />
import type { DurableObjectState } from "@cloudflare/workers-types"
import { EventLogDurableObject } from "@effect/experimental/EventLogServer/Cloudflare"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as EventLogServer from "@effect/experimental/EventLogServer"
import * as EventLogRemote from "@effect/experimental/EventLogRemote"
import { layerStorageDo } from "../storage/StorageDo.js"
import { layerStorageD1 } from "../storage/StorageD1.js"
import type { SyncDoEnv } from "../types.js"

class SyncStorageUnavailableError extends Schema.TaggedError<SyncStorageUnavailableError>()(
  "SyncStorageUnavailableError",
  {
    message: Schema.String
  }
) {}

const makeStorageLayer = (
  ctx: DurableObjectState,
  env: SyncDoEnv
): Layer.Layer<EventLogServer.Storage> => {
  if (env.SYNC_DB) {
    return layerStorageD1(env.SYNC_DB)
  }
  if (!ctx.storage.sql) {
    throw SyncStorageUnavailableError.make({
      message: "Durable Object sqlite storage is not available. Enable durable_object_sqlite."
    })
  }
  return layerStorageDo(ctx.storage.sql)
}

export class SyncDurableObject extends EventLogDurableObject {
  private readonly debug: boolean

  constructor(ctx: DurableObjectState, env: SyncDoEnv) {
    super({
      ctx,
      env,
      storageLayer: makeStorageLayer(ctx, env)
    })
    this.debug = env.SYNC_DEBUG === "1" || env.SYNC_DEBUG === "true"
  }

  override webSocketOpen(_ws: WebSocket) {
    if (this.debug) {
      const peers = this.ctx.getWebSockets().length
      console.log("[sync-do] WebSocket open", { peers })
    }
  }

  override webSocketClose(_ws: WebSocket, code: number, reason: string) {
    if (this.debug) {
      const peers = this.ctx.getWebSockets().length
      console.log("[sync-do] WebSocket close", { code, reason, peers })
    }
    return super.webSocketClose(_ws, code, reason)
  }

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (this.debug) {
      try {
        const bytes =
          message instanceof ArrayBuffer
            ? new Uint8Array(message)
            : new TextEncoder().encode(message)
        const request = EventLogRemote.decodeRequest(bytes)
        switch (request._tag) {
          case "WriteEntries": {
            console.log("[sync-do] WriteEntries", {
              id: request.id,
              publicKey: request.publicKey,
              entries: request.encryptedEntries.length,
              peers: this.ctx.getWebSockets().length
            })
            break
          }
          case "RequestChanges": {
            console.log("[sync-do] RequestChanges", {
              id: request.id,
              publicKey: request.publicKey,
              startSequence: request.startSequence,
              peers: this.ctx.getWebSockets().length
            })
            break
          }
          case "ChunkedMessage": {
            console.log("[sync-do] ChunkedMessage", {
              id: request.id,
              chunk: request.chunk,
              total: request.total,
              bytes: request.data.byteLength
            })
            break
          }
          case "StopChanges": {
            console.log("[sync-do] StopChanges", {
              id: request.id,
              publicKey: request.publicKey
            })
            break
          }
          case "Ping": {
            console.log("[sync-do] Ping", { id: request.id })
            break
          }
          default: {
            console.log("[sync-do] Request", { tag: request._tag })
            break
          }
        }
      } catch (error) {
        console.warn("[sync-do] Failed to decode request", error)
      }
    }

    return super.webSocketMessage(ws, message)
  }
}
