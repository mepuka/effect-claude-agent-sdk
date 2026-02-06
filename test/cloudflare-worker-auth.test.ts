import { expect, test } from "bun:test"
import { authorizeRequest } from "../cloudflare/src/auth.ts"

const makeEnv = (overrides?: {
  readonly SYNC_AUTH_TOKEN?: string
  readonly SYNC_ALLOW_QUERY_TOKEN?: string
}) =>
  ({
    SYNC_DO: {} as any,
    ...(overrides ?? {})
  }) as any

test("worker authorizes when protocol token is valid even with stale bearer", async () => {
  const request = new Request("https://example.com/event-log/demo", {
    headers: {
      Authorization: "Bearer stale",
      "Sec-WebSocket-Protocol": "sync-auth.secret-token"
    }
  })
  const result = authorizeRequest(
    request,
    makeEnv({ SYNC_AUTH_TOKEN: "secret-token" }),
    new URL(request.url)
  )

  expect(result.ok).toBe(true)
  expect(result.protocol).toBe("sync-auth.secret-token")
})

test("worker authorizes query token fallback when enabled, even with stale bearer", async () => {
  const request = new Request("https://example.com/event-log/demo?token=secret-token", {
    headers: {
      Authorization: "Bearer stale"
    }
  })
  const result = authorizeRequest(
    request,
    makeEnv({
      SYNC_AUTH_TOKEN: "secret-token",
      SYNC_ALLOW_QUERY_TOKEN: "true"
    }),
    new URL(request.url)
  )

  expect(result.ok).toBe(true)
})

test("worker rejects requests with no matching auth token", async () => {
  const request = new Request("https://example.com/event-log/demo", {
    headers: {
      Authorization: "Bearer stale",
      "Sec-WebSocket-Protocol": "sync-auth.other-token"
    }
  })
  const result = authorizeRequest(
    request,
    makeEnv({ SYNC_AUTH_TOKEN: "secret-token" }),
    new URL(request.url)
  )

  expect(result.ok).toBe(false)
})
