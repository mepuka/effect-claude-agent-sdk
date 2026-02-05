/// <reference types="@cloudflare/workers-types" />
import type { DurableObjectState } from "@cloudflare/workers-types"
import { EventLogDurableObject } from "@effect/experimental/EventLogServer/Cloudflare"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as EventLogServer from "@effect/experimental/EventLogServer"
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
  constructor(ctx: DurableObjectState, env: SyncDoEnv) {
    super({
      ctx,
      env,
      storageLayer: makeStorageLayer(ctx, env)
    })
  }
}
