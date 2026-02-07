import type { SyncWorkerEnv } from "./types.js"

const parseProtocolToken = (request: Request) => {
  const header = request.headers.get("Sec-WebSocket-Protocol")
  if (!header) return undefined
  const protocols = header
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
  const authProtocol = protocols.find((entry) => entry.startsWith("sync-auth."))
  if (!authProtocol) return undefined
  return {
    token: authProtocol.slice("sync-auth.".length),
    protocol: authProtocol
  }
}

const parseTenantTokenMap = (raw: string | undefined) => {
  if (!raw) return undefined
  try {
    const decoded = JSON.parse(raw)
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return undefined
    const pairs = Object.entries(decoded).filter((entry): entry is [string, string] =>
      typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1].length > 0
    )
    if (pairs.length === 0) return undefined
    return new Map(pairs)
  } catch {
    return undefined
  }
}

const resolveExpectedToken = (env: SyncWorkerEnv, tenant?: string) => {
  const tenantMap = parseTenantTokenMap(env.SYNC_AUTH_TOKENS)
  const tenantToken = tenantMap && tenant ? tenantMap.get(tenant) : undefined
  const wildcardToken = tenantMap?.get("*")
  return tenantToken ?? wildcardToken ?? env.SYNC_AUTH_TOKEN
}

export const authorizeRequest = (
  request: Request,
  env: SyncWorkerEnv,
  url: URL,
  tenant?: string
) => {
  const expected = resolveExpectedToken(env, tenant)
  if (!expected) return { ok: true, protocol: undefined }
  const header = request.headers.get("Authorization")
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined
  const protocol = parseProtocolToken(request)
  const protocolMatch = protocol?.token === expected ? protocol.protocol : undefined
  const allowQuery =
    env.SYNC_ALLOW_QUERY_TOKEN === "1" || env.SYNC_ALLOW_QUERY_TOKEN === "true"
  const query = allowQuery ? url.searchParams.get("token") ?? undefined : undefined
  const bearerMatch = bearer === expected
  const queryMatch = query === expected
  const ok = bearerMatch || protocolMatch !== undefined || queryMatch
  return { ok, protocol: ok ? protocolMatch : undefined }
}
