import type { SyncWorkerEnv } from "./types.js"
import { SyncDurableObject } from "./do/SyncDurableObject.js"

const isWebSocketUpgrade = (request: Request) =>
  request.headers.get("Upgrade")?.toLowerCase() === "websocket"

const getTenantId = (url: URL) => {
  const explicit = url.searchParams.get("tenant")
  if (explicit) return explicit
  const parts = url.pathname.split("/").filter(Boolean)
  if (parts[0] !== "event-log") return "default"
  return parts[1] ?? "default"
}

const authorize = (request: Request, env: SyncWorkerEnv, url: URL) => {
  const expected = env.SYNC_AUTH_TOKEN
  if (!expected) return true
  const header = request.headers.get("Authorization")
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined
  const query = url.searchParams.get("token") ?? undefined
  return bearer === expected || query === expected
}

export default {
  async fetch(request: Request, env: SyncWorkerEnv): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.startsWith("/event-log")) {
      return new Response("Not found", { status: 404 })
    }
    if (!authorize(request, env, url)) {
      return new Response("Unauthorized", { status: 401 })
    }
    if (!isWebSocketUpgrade(request)) {
      return new Response("Expected WebSocket upgrade", { status: 426 })
    }
    const tenant = getTenantId(url)
    const id = env.SYNC_DO.idFromName(tenant)
    const stub = env.SYNC_DO.get(id)
    try {
      return await stub.fetch(request)
    } catch (error) {
      console.error("Sync durable object fetch failed.", error)
      return new Response("Sync durable object unavailable.", { status: 502 })
    }
  }
}

export { SyncDurableObject }
