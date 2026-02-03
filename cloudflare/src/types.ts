import type { D1Database, DurableObjectNamespace } from "@cloudflare/workers-types"

export type SyncWorkerEnv = {
  readonly SYNC_DO: DurableObjectNamespace
  readonly SYNC_DB?: D1Database
  readonly SYNC_AUTH_TOKEN?: string
}

export type SyncDoEnv = {
  readonly SYNC_DB?: D1Database
  readonly SYNC_AUTH_TOKEN?: string
}
