import { expect, mock, test } from "bun:test"

const loadWorker = async () => {
  mock.module("cloudflare:workers", () => ({
    DurableObject: class DurableObject {}
  }))
  return (await import("../src/worker.ts")).default
}

const makeEnv = (overrides?: {
  readonly SYNC_AUTH_TOKEN?: string
  readonly SYNC_AUTH_TOKENS?: string
}) => {
  const seenTenants: Array<string> = []
  const seenFetches: Array<string> = []
  const stub = {
    fetch: async (request: Request) => {
      seenFetches.push(request.url)
      return new Response("proxied", { status: 200 })
    }
  }
  const env = {
    SYNC_DO: {
      idFromName: (tenant: string) => {
        seenTenants.push(tenant)
        return `id:${tenant}` as never
      },
      get: () => stub as never
    },
    ...(overrides ?? {})
  } as never
  return { env, seenTenants, seenFetches }
}

const wsRequest = (url: string, headers?: Record<string, string>) =>
  new Request(url, {
    headers: {
      Upgrade: "websocket",
      ...(headers ?? {})
    }
  })

test("cloudflare worker returns 400 when tenant is missing", async () => {
  const worker = await loadWorker()
  const { env, seenTenants } = makeEnv()
  const response = await worker.fetch(
    wsRequest("https://example.com/event-log"),
    env
  )
  expect(response.status).toBe(400)
  expect(await response.text()).toContain("Tenant is required")
  expect(seenTenants.length).toBe(0)
})

test("cloudflare worker returns 400 for invalid tenant format", async () => {
  const worker = await loadWorker()
  const { env, seenTenants } = makeEnv()
  const response = await worker.fetch(
    wsRequest("https://example.com/event-log/bad%2Ftenant"),
    env
  )
  expect(response.status).toBe(400)
  expect(await response.text()).toContain("Invalid tenant format")
  expect(seenTenants.length).toBe(0)
})

test("cloudflare worker enforces tenant token auth before DO dispatch", async () => {
  const worker = await loadWorker()
  const { env, seenTenants, seenFetches } = makeEnv({
    SYNC_AUTH_TOKENS: JSON.stringify({ demo: "demo-token" })
  })
  const response = await worker.fetch(
    wsRequest("https://example.com/event-log/demo", {
      Authorization: "Bearer wrong-token"
    }),
    env
  )
  expect(response.status).toBe(401)
  expect(seenTenants.length).toBe(0)
  expect(seenFetches.length).toBe(0)
})

test("cloudflare worker routes authorized tenant request to matching durable object", async () => {
  const worker = await loadWorker()
  const { env, seenTenants, seenFetches } = makeEnv({
    SYNC_AUTH_TOKENS: JSON.stringify({ demo: "demo-token", "*": "fallback-token" })
  })
  const response = await worker.fetch(
    wsRequest("https://example.com/event-log/demo", {
      Authorization: "Bearer demo-token"
    }),
    env
  )
  expect(response.status).toBe(200)
  expect(await response.text()).toBe("proxied")
  expect(seenTenants).toEqual(["demo"])
  expect(seenFetches.length).toBe(1)
})
