import * as Duration from "effect/Duration"
import * as Layer from "effect/Layer"
import { AgentRuntime, type PersistenceLayers } from "./AgentRuntime.js"
import { AgentRuntimeConfig } from "./AgentRuntimeConfig.js"
import { AgentSdk } from "./AgentSdk.js"
import { AgentSdkConfig } from "./AgentSdkConfig.js"
import { QuerySupervisor } from "./QuerySupervisor.js"
import { QuerySupervisorConfig } from "./QuerySupervisorConfig.js"
import { ArtifactStore } from "./Storage/ArtifactStore.js"
import { AuditEventStore } from "./Storage/AuditEventStore.js"
import { ChatHistoryStore } from "./Storage/ChatHistoryStore.js"
import { SessionIndexStore } from "./Storage/SessionIndexStore.js"
import { StorageConfig } from "./Storage/StorageConfig.js"
import { layers as storageLayers } from "./Storage/StorageLayers.js"

export type QuickConfig = {
  readonly apiKey?: string
  readonly model?: string
  readonly timeout?: Duration.DurationInput
  readonly concurrency?: number
  readonly persistence?:
    | "memory"
    | "filesystem"
    | { readonly directory: string }
    | { readonly sync: string }
}

type ResolvedQuickConfig = {
  readonly apiKey?: string
  readonly model?: string
  readonly timeout: Duration.DurationInput
  readonly concurrency: number
  readonly persistence: NonNullable<QuickConfig["persistence"]>
}

const resolveQuickConfig = (config?: QuickConfig): ResolvedQuickConfig => ({
  ...(config?.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
  ...(config?.model !== undefined ? { model: config.model } : {}),
  timeout: config?.timeout ?? Duration.minutes(5),
  concurrency: config?.concurrency ?? 4,
  persistence: config?.persistence ?? "memory"
})

const buildRuntimeLayer = (config: ResolvedQuickConfig) => {
  const runtimeConfigLayer = AgentRuntimeConfig.layerWith({
    queryTimeout: Duration.decode(config.timeout)
  })
  const supervisorConfigLayer = QuerySupervisorConfig.layerWith({
    concurrencyLimit: config.concurrency
  })
  const sdkOverrides: { apiKey?: string; model?: string } = {}
  if (config.apiKey !== undefined) {
    sdkOverrides.apiKey = config.apiKey
  }
  if (config.model !== undefined) {
    sdkOverrides.model = config.model
  }
  const sdkConfigLayer = Object.keys(sdkOverrides).length > 0
    ? AgentSdkConfig.layerWithOverrides(sdkOverrides)
    : AgentSdkConfig.layer

  const sdkLayer = AgentSdk.layer.pipe(
    Layer.provide(sdkConfigLayer)
  )

  const supervisorLayer = QuerySupervisor.layer.pipe(
    Layer.provide(supervisorConfigLayer),
    Layer.provide(sdkLayer)
  )

  return AgentRuntime.layer.pipe(
    Layer.provide(runtimeConfigLayer),
    Layer.provide(supervisorLayer)
  )
}

const memoryPersistenceLayers = (runtime: Layer.Layer<AgentRuntime, unknown, never>): PersistenceLayers => ({
  runtime,
  chatHistory: ChatHistoryStore.layerMemory,
  artifacts: ArtifactStore.layerMemory,
  auditLog: AuditEventStore.layerMemory,
  sessionIndex: SessionIndexStore.layerMemory,
  storageConfig: StorageConfig.layer
})

/**
 * Build a convenience AgentRuntime layer using simplified configuration.
 */
export const runtimeLayer = (config?: QuickConfig) => {
  const resolved = resolveQuickConfig(config)
  const runtime = buildRuntimeLayer(resolved)

  if (resolved.persistence === "memory") {
    return AgentRuntime.layerWithPersistence({
      layers: memoryPersistenceLayers(runtime)
    })
  }

  if (resolved.persistence === "filesystem") {
    const storage = storageLayers({ backend: "bun", mode: "standard" })
    return AgentRuntime.layerWithPersistence({
      layers: {
        runtime,
        chatHistory: storage.chatHistory,
        artifacts: storage.artifacts,
        auditLog: storage.auditLog,
        sessionIndex: storage.sessionIndex,
        storageConfig: StorageConfig.layer
      }
    })
  }

  if ("directory" in resolved.persistence) {
    const storage = storageLayers({
      backend: "bun",
      mode: "standard",
      directory: resolved.persistence.directory
    })
    return AgentRuntime.layerWithPersistence({
      layers: {
        runtime,
        chatHistory: storage.chatHistory,
        artifacts: storage.artifacts,
        auditLog: storage.auditLog,
        sessionIndex: storage.sessionIndex,
        storageConfig: StorageConfig.layer
      }
    })
  }

  return AgentRuntime.layerWithRemoteSync({
    url: resolved.persistence.sync,
    layers: {
      runtime
    }
  })
}
