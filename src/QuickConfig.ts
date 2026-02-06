import { BunFileSystem, BunPath } from "@effect/platform-bun"
import * as Duration from "effect/Duration"
import * as Layer from "effect/Layer"
import { AgentRuntime, type PersistenceLayers } from "./AgentRuntime.js"
import { AgentRuntimeConfig } from "./AgentRuntimeConfig.js"
import { AgentSdk } from "./AgentSdk.js"
import { AgentSdkConfig } from "./AgentSdkConfig.js"
import { QuerySupervisor } from "./QuerySupervisor.js"
import { QuerySupervisorConfig } from "./QuerySupervisorConfig.js"
import { layerCloudflare, type CloudflareSandboxEnv } from "./Sandbox/SandboxCloudflare.js"
import { ArtifactStore } from "./Storage/ArtifactStore.js"
import { AuditEventStore } from "./Storage/AuditEventStore.js"
import { ChatHistoryStore } from "./Storage/ChatHistoryStore.js"
import { SessionIndexStore } from "./Storage/SessionIndexStore.js"
import { StorageConfig } from "./Storage/StorageConfig.js"
import {
  layers as storageLayers,
  type CloudflareStorageBindings,
  type StorageBackend,
  type StorageMode
} from "./Storage/StorageLayers.js"

type QuickConfigCloudflareSandbox = {
  readonly provider: "cloudflare"
  readonly sandboxId: string
  readonly env: CloudflareSandboxEnv
  readonly sleepAfter?: string
  readonly apiKey?: string
}

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
  // Execution backend. Different from Options.sandbox (Claude Code sandbox flags).
  readonly sandbox?: "local" | QuickConfigCloudflareSandbox
  readonly storageBackend?: StorageBackend
  readonly storageMode?: StorageMode
  readonly storageBindings?: CloudflareStorageBindings
}

type ResolvedQuickConfig = {
  readonly apiKey?: string
  readonly model?: string
  readonly timeout: Duration.DurationInput
  readonly concurrency: number
  readonly persistence: NonNullable<QuickConfig["persistence"]>
  readonly sandbox?: QuickConfig["sandbox"]
  readonly storageBackend?: StorageBackend
  readonly storageMode?: StorageMode
  readonly storageBindings?: CloudflareStorageBindings
}

const resolveQuickConfig = (config?: QuickConfig): ResolvedQuickConfig => ({
  ...(config?.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
  ...(config?.model !== undefined ? { model: config.model } : {}),
  ...(config?.sandbox !== undefined ? { sandbox: config.sandbox } : {}),
  ...(config?.storageBackend !== undefined ? { storageBackend: config.storageBackend } : {}),
  ...(config?.storageMode !== undefined ? { storageMode: config.storageMode } : {}),
  ...(config?.storageBindings !== undefined ? { storageBindings: config.storageBindings } : {}),
  timeout: config?.timeout ?? Duration.minutes(5),
  concurrency: config?.concurrency ?? 4,
  persistence: config?.persistence ?? "memory"
})

const validateQuickConfig = (config: ResolvedQuickConfig) => {
  const backend = config.storageBackend
  const mode = config.storageMode
  const isSyncPersistence = typeof config.persistence === "object" && "sync" in config.persistence

  if (backend === "kv" && mode === "journaled") {
    throw new Error(
      "QuickConfig: storageBackend 'kv' cannot be used with storageMode 'journaled'."
    )
  }

  if (isSyncPersistence && (backend === "r2" || backend === "kv")) {
    throw new Error(
      `QuickConfig: persistence.sync is not supported with storageBackend '${backend}'. Use backend 'bun' or 'filesystem'.`
    )
  }
}

const buildRuntimeLayer = (
  config: ResolvedQuickConfig
): Layer.Layer<AgentRuntime, unknown, never> => {
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

const resolveSandboxLayer = (config: ResolvedQuickConfig) => {
  if (!config.sandbox || config.sandbox === "local") {
    return undefined
  }
  return layerCloudflare({
    env: config.sandbox.env,
    sandboxId: config.sandbox.sandboxId,
    ...(config.sandbox.sleepAfter !== undefined
      ? { sleepAfter: config.sandbox.sleepAfter }
      : {}),
    ...(config.sandbox.apiKey !== undefined ? { apiKey: config.sandbox.apiKey } : {})
  })
}

const resolveStorageLayers = (config: ResolvedQuickConfig) => {
  const backend = config.storageBackend ?? "bun"
  const mode = config.storageMode ?? "standard"
  const directory = typeof config.persistence === "object" && "directory" in config.persistence
    ? config.persistence.directory
    : undefined
  const commonOptions = {
    mode,
    ...(directory !== undefined ? { directory } : {}),
    ...(config.storageBindings !== undefined ? { bindings: config.storageBindings } : {})
  }
  switch (backend) {
    case "filesystem": {
      const layers = storageLayers({
        backend: "filesystem",
        ...commonOptions
      })
      const bunFileSystemLayers = [BunFileSystem.layer, BunPath.layer] as const
      return {
        chatHistory: layers.chatHistory.pipe(Layer.provide(bunFileSystemLayers)),
        artifacts: layers.artifacts.pipe(Layer.provide(bunFileSystemLayers)),
        auditLog: layers.auditLog.pipe(Layer.provide(bunFileSystemLayers)),
        sessionIndex: layers.sessionIndex.pipe(Layer.provide(bunFileSystemLayers))
      }
    }
    case "r2":
      return storageLayers({
        backend: "r2",
        ...commonOptions
      })
    case "kv":
      return storageLayers({
        backend: "kv",
        ...commonOptions
      })
    default:
      return storageLayers({
        backend: "bun",
        ...commonOptions
      })
  }
}

/**
 * Build a convenience AgentRuntime layer using simplified configuration.
 */
export const runtimeLayer = (config?: QuickConfig) => {
  const resolved = resolveQuickConfig(config)
  validateQuickConfig(resolved)
  const runtime = buildRuntimeLayer(resolved)
  const sandboxLayer = resolveSandboxLayer(resolved)
  const runtimeWithSandbox: Layer.Layer<AgentRuntime, unknown, never> = sandboxLayer
    ? runtime.pipe(Layer.provide(sandboxLayer))
    : runtime

  if (resolved.persistence === "memory") {
    return AgentRuntime.layerWithPersistence({
      layers: memoryPersistenceLayers(runtimeWithSandbox)
    })
  }

  if (typeof resolved.persistence === "object" && "sync" in resolved.persistence) {
    return AgentRuntime.layerWithRemoteSync({
      url: resolved.persistence.sync,
      layers: {
        runtime: runtimeWithSandbox
      }
    })
  }

  const storage = resolveStorageLayers(resolved)
  return AgentRuntime.layerWithPersistence({
    layers: {
      runtime: runtimeWithSandbox,
      chatHistory: storage.chatHistory,
      artifacts: storage.artifacts,
      auditLog: storage.auditLog,
      sessionIndex: storage.sessionIndex,
      storageConfig: StorageConfig.layer
    }
  })
}
