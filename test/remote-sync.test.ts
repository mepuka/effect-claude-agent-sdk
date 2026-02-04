import { test, expect } from "bun:test"
import { buildRemoteUrl } from "../src/Sync/RemoteSync.js"

test("buildRemoteUrl adds /event-log when missing", () => {
  const url = buildRemoteUrl("wss://sync.example.com")
  expect(url).toBe("wss://sync.example.com/event-log")
})

test("buildRemoteUrl appends tenant and token", () => {
  const url = buildRemoteUrl("wss://sync.example.com/event-log", {
    tenant: "demo",
    authToken: "token-123"
  })
  expect(url).toBe("wss://sync.example.com/event-log/demo?token=token-123")
})

test("buildRemoteUrl preserves custom path", () => {
  const url = buildRemoteUrl("wss://sync.example.com/custom", {
    tenant: "demo"
  })
  expect(url).toBe("wss://sync.example.com/custom")
})
