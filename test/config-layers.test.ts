import { expect, test } from "bun:test"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Layer from "effect/Layer"
import { AgentRuntimeConfig } from "../src/AgentRuntimeConfig.js"
import { AgentSdkConfig } from "../src/AgentSdkConfig.js"
import { QuerySupervisorConfig } from "../src/QuerySupervisorConfig.js"
import { runEffect } from "./effect-test.js"

const configLayer = (entries: Record<string, string>) =>
  Layer.setConfigProvider(
    ConfigProvider.fromMap(new Map(Object.entries(entries)))
  )

test("AgentSdkConfig reads options from config provider", async () => {
  const layer = AgentSdkConfig.layer.pipe(
    Layer.provide(
      configLayer({
        ANTHROPIC_API_KEY: "test-key",
        MODEL: "claude-test",
        SETTING_SOURCES: "project,local",
        EXECUTABLE: "bun",
        PERMISSION_MODE: "plan"
      })
    )
  )

  const program = Effect.gen(function*() {
    const config = yield* AgentSdkConfig
    return config.options
  }).pipe(Effect.provide(layer))

  const options = await runEffect(program)
  expect(options.model).toBe("claude-test")
  expect(options.settingSources).toEqual(["project", "local"])
  expect(options.env?.ANTHROPIC_API_KEY).toBe("test-key")
  expect(options.executable).toBe("bun")
  expect(options.permissionMode).toBe("plan")
})

test("AgentSdkConfig rejects invalid setting sources", async () => {
  const layer = AgentSdkConfig.layer.pipe(
    Layer.provide(
      configLayer({
        SETTING_SOURCES: "project,banana"
      })
    )
  )

  const program = AgentSdkConfig.pipe(Effect.provide(layer))

  const result = await runEffect(Effect.either(program))
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isLeft(result)) {
    expect(result.left._tag).toBe("ConfigError")
  }
})

test("AgentRuntimeConfig bounds retry settings and parses durations", async () => {
  const layer = AgentRuntimeConfig.layer.pipe(
    Layer.provide(
      configLayer({
        QUERY_TIMEOUT: "5 seconds",
        FIRST_MESSAGE_TIMEOUT: "2 seconds",
        RETRY_MAX_RETRIES: "-3",
        RETRY_BASE_DELAY: "250 millis"
      })
    )
  )

  const program = Effect.gen(function*() {
    const config = yield* AgentRuntimeConfig
    return config.settings
  }).pipe(Effect.provide(layer))

  const settings = await runEffect(program)
  expect(Duration.toMillis(settings.queryTimeout!)).toBe(5000)
  expect(Duration.toMillis(settings.firstMessageTimeout!)).toBe(2000)
  expect(settings.retryMaxRetries).toBe(0)
  expect(Duration.toMillis(settings.retryBaseDelay)).toBe(250)
})

test("QuerySupervisorConfig enforces minimums", async () => {
  const layer = QuerySupervisorConfig.layer.pipe(
    Layer.provide(
      configLayer({
        CONCURRENCY_LIMIT: "0",
        PENDING_QUEUE_CAPACITY: "-1",
        PENDING_QUEUE_STRATEGY: "dropping",
        MAX_PENDING_TIME: "5 seconds",
        EMIT_EVENTS: "true",
        EVENT_BUFFER_CAPACITY: "0",
        EVENT_BUFFER_STRATEGY: "sliding",
        METRICS_ENABLED: "true",
        TRACING_ENABLED: "true"
      })
    )
  )

  const program = Effect.gen(function*() {
    const config = yield* QuerySupervisorConfig
    return config.settings
  }).pipe(Effect.provide(layer))

  const settings = await runEffect(program)
  expect(settings.concurrencyLimit).toBe(1)
  expect(settings.pendingQueueCapacity).toBe(0)
  expect(settings.pendingQueueStrategy).toBe("dropping")
  expect(Duration.toMillis(settings.maxPendingTime!)).toBe(5000)
  expect(settings.emitEvents).toBe(true)
  expect(settings.eventBufferCapacity).toBe(1)
  expect(settings.eventBufferStrategy).toBe("sliding")
  expect(settings.metricsEnabled).toBe(true)
  expect(settings.tracingEnabled).toBe(true)
})
