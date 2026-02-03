# Cloudflare Remote Sync (Worker + Durable Object)

This package provides a Cloudflare Worker entrypoint and Durable Object that implement the
EventLogRemote protocol for syncing SDK replicas. The Durable Object uses Effect’s
`EventLogDurableObject` and a configurable `EventLogServer.Storage` layer.

## Quick Start
1. Copy `wrangler.toml` and adjust `name`, `account_id`, and `compatibility_date`.
2. Ensure Durable Object SQLite is enabled:
   - `compatibility_flags = ["durable_object_sqlite"]`
   - `migrations = [{ tag = "v1", new_sqlite_classes = ["SyncDurableObject"] }]`
3. Bind the Durable Object:
   - `SYNC_DO` → `SyncDurableObject`

Optional: bind a D1 database as `SYNC_DB` to use D1 storage instead of DO SQLite.

## Storage Mode
- **Default (recommended v1):** Durable Object SQLite (`ctx.storage.sql`)
- **Optional:** D1 via `SYNC_DB` binding

## Auth
Set `SYNC_AUTH_TOKEN` (Worker env var). The worker accepts:
- `Authorization: Bearer <token>`
- `?token=<token>` query param

## Client Notes
Cloudflare DO does **not** implement Ping/Pong or StopChanges. For Cloudflare endpoints,
clients should set `disablePing: true` unless the DO is extended to handle Ping/Pong.

## Files
- `src/worker.ts` — Worker entrypoint (routing + auth)
- `src/do/SyncDurableObject.ts` — Durable Object class
- `src/storage/StorageDo.ts` — DO SQLite storage layer
- `src/storage/StorageD1.ts` — D1 storage layer
