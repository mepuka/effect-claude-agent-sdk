import { KeyValueStore } from "@effect/platform"
import { BunFileSystem, BunKeyValueStore, BunPath } from "@effect/platform-bun"
import type { FileSystem } from "@effect/platform/FileSystem"
import type { Path } from "@effect/platform/Path"
import type * as Duration from "effect/Duration"
import * as Layer from "effect/Layer"
import { ArtifactStore } from "./ArtifactStore.js"
import { AuditEventStore } from "./AuditEventStore.js"
import { ChatHistoryStore } from "./ChatHistoryStore.js"
import { SessionIndexStore } from "./SessionIndexStore.js"
import { defaultStorageDirectory } from "./defaults.js"
import type { ConflictPolicy } from "../Sync/ConflictPolicy.js"
import { SyncConfig, SyncService } from "../Sync/SyncService.js"

export type StorageLayerOptions = {
  readonly directory?: string
}

export type StorageBackend = "filesystem" | "bun"
export type StorageMode = "standard" | "journaled"

export type StorageLayers<E = unknown, R = unknown> = {
  readonly chatHistory: Layer.Layer<ChatHistoryStore, E, R>
  readonly artifacts: Layer.Layer<ArtifactStore, E, R>
  readonly auditLog: Layer.Layer<AuditEventStore, E, R>
  readonly sessionIndex: Layer.Layer<SessionIndexStore, E, R>
}

export type StorageLayersWithSync<E = unknown, R = unknown> = StorageLayers<E, R> & {
  readonly sync?: Layer.Layer<SyncService, E, R>
}

export type StorageSyncLayerOptions<R = never> = StorageLayerOptions & {
  readonly syncInterval?: Duration.DurationInput
  readonly disablePing?: boolean
  readonly protocols?: string | Array<string>
  readonly syncChatHistory?: boolean
  readonly syncArtifacts?: boolean
  readonly conflictPolicy?: Layer.Layer<ConflictPolicy, unknown, R>
  readonly exposeSync?: boolean
}

export type StorageSyncOptions<R = never> = Omit<StorageSyncLayerOptions<R>, "directory"> & {
  readonly url: string
}

export type StorageLayerBundleOptions<R = never> = StorageLayerOptions & {
  readonly backend?: StorageBackend
  readonly mode?: StorageMode
  readonly sync?: StorageSyncOptions<R>
}

const resolveDirectory = (directory: string | undefined) =>
  directory === undefined ? undefined : { directory }

const resolveLayers = (
  options: StorageLayerOptions | undefined,
  kind: "filesystem" | "bun",
  mode: "standard" | "journaled"
) => {
  const directory = resolveDirectory(options?.directory)
  const journaled = mode === "journaled"
  return {
    chatHistory: kind === "bun"
      ? journaled
        ? ChatHistoryStore.layerJournaledFileSystemBun(directory)
        : ChatHistoryStore.layerFileSystemBun(directory)
      : journaled
        ? ChatHistoryStore.layerJournaledFileSystem(directory)
        : ChatHistoryStore.layerFileSystem(directory),
    artifacts: kind === "bun"
      ? journaled
        ? ArtifactStore.layerJournaledFileSystemBun(directory)
        : ArtifactStore.layerFileSystemBun(directory)
      : journaled
        ? ArtifactStore.layerJournaledFileSystem(directory)
        : ArtifactStore.layerFileSystem(directory),
    auditLog: kind === "bun"
      ? AuditEventStore.layerFileSystemBun(directory)
      : AuditEventStore.layerFileSystem(directory),
    sessionIndex: kind === "bun"
      ? SessionIndexStore.layerFileSystemBun(directory)
      : SessionIndexStore.layerFileSystem(directory)
  }
}

const mergeLayers = <E, R>(layers: StorageLayers<E, R>) =>
  Layer.mergeAll(
    layers.chatHistory,
    layers.artifacts,
    layers.auditLog,
    layers.sessionIndex
  )

type BunDependencies = FileSystem | Path

const provideBunLayers = <E, R>(
  layers: StorageLayers<E, R>
): StorageLayers<E, Exclude<R, BunDependencies>> => ({
  chatHistory: layers.chatHistory.pipe(
    Layer.provide([bunFileSystemLayer, bunPathLayer])
  ),
  artifacts: layers.artifacts.pipe(
    Layer.provide([bunFileSystemLayer, bunPathLayer])
  ),
  auditLog: layers.auditLog.pipe(
    Layer.provide([bunFileSystemLayer, bunPathLayer])
  ),
  sessionIndex: layers.sessionIndex.pipe(
    Layer.provide([bunFileSystemLayer, bunPathLayer])
  )
})

export const layersFileSystem = (options?: StorageLayerOptions) =>
  resolveLayers(options, "filesystem", "standard")

export const layersFileSystemJournaled = (options?: StorageLayerOptions) =>
  resolveLayers(options, "filesystem", "journaled")

const bunFileSystemLayer = BunFileSystem.layer
const bunPathLayer = BunPath.layer

export const layersFileSystemBun = (
  options?: StorageLayerOptions
): StorageLayers<unknown, never> => {
  const layers = resolveLayers(options, "bun", "standard")
  return provideBunLayers(layers)
}

export const layersFileSystemBunJournaled = (
  options?: StorageLayerOptions
): StorageLayers<unknown, never> => {
  const layers = resolveLayers(options, "bun", "journaled")
  return provideBunLayers(layers)
}

export const layerFileSystem = (options?: StorageLayerOptions) => {
  const layers = resolveLayers(options, "filesystem", "standard")
  return mergeLayers(layers)
}

export const layerFileSystemBun = (options?: StorageLayerOptions) => {
  const layers = layersFileSystemBun(options)
  return mergeLayers(layers)
}

export const layerFileSystemJournaled = (options?: StorageLayerOptions) => {
  const layers = resolveLayers(options, "filesystem", "journaled")
  return mergeLayers(layers)
}

export const layerFileSystemBunJournaled = (options?: StorageLayerOptions) => {
  const layers = layersFileSystemBunJournaled(options)
  return mergeLayers(layers)
}

const resolveSyncOptions = (options?: StorageSyncLayerOptions<unknown>) =>
  options?.disablePing !== undefined || options?.protocols !== undefined
    ? {
        ...(options?.disablePing !== undefined ? { disablePing: options.disablePing } : {}),
        ...(options?.protocols !== undefined ? { protocols: options.protocols } : {})
      }
    : undefined

const resolveSyncFlags = (options?: StorageSyncLayerOptions<unknown>) => ({
  syncChatHistory: options?.syncChatHistory ?? true,
  syncArtifacts: options?.syncArtifacts ?? false,
  exposeSync: options?.exposeSync ?? false
})

const buildChatSyncLayers = <RBase, ROptions>(
  url: string,
  options: StorageSyncLayerOptions<ROptions> | undefined,
  kvsLayer: Layer.Layer<KeyValueStore.KeyValueStore, unknown, RBase>
): {
  readonly chatHistory: Layer.Layer<ChatHistoryStore, unknown, RBase | ROptions>
  readonly syncLayer: Layer.Layer<SyncService, unknown, RBase | ROptions>
} => {
  const baseLayer = ChatHistoryStore.layerJournaledWithEventLog(
    options?.conflictPolicy !== undefined ? { conflictPolicy: options.conflictPolicy } : undefined
  ).pipe(Layer.provide(kvsLayer))
  const chatHistory = Layer.project(
    baseLayer,
    ChatHistoryStore,
    ChatHistoryStore,
    (store) => store
  )
  let syncLayer = SyncService.layerWebSocket(
    url,
    resolveSyncOptions(options)
  ).pipe(Layer.provide(baseLayer))
  if (options?.syncInterval !== undefined) {
    syncLayer = syncLayer.pipe(
      Layer.provide(SyncConfig.layer({ syncInterval: options.syncInterval }))
    )
  }
  return { chatHistory, syncLayer }
}

const buildJournaledSyncLayers = <RBase, ROptions>(
  url: string,
  options: StorageSyncLayerOptions<ROptions> | undefined,
  baseLayers: StorageLayers<unknown, RBase>,
  kvsLayer: Layer.Layer<KeyValueStore.KeyValueStore, unknown, RBase>
): StorageLayersWithSync<unknown, RBase | ROptions> => {
  const flags = resolveSyncFlags(options)
  let syncLayer: Layer.Layer<SyncService, unknown, RBase | ROptions> | undefined
  const chatHistory = flags.syncChatHistory
    ? flags.exposeSync
      ? (() => {
          const chatSync = buildChatSyncLayers(url, options, kvsLayer)
          syncLayer = chatSync.syncLayer
          return chatSync.chatHistory
        })()
      : ChatHistoryStore.layerJournaledWithSyncWebSocket(
          url,
          options
        ).pipe(Layer.provide(kvsLayer))
    : baseLayers.chatHistory

  const artifacts = flags.syncArtifacts
    ? ArtifactStore.layerJournaledWithSyncWebSocket(
        url,
        options
      ).pipe(Layer.provide(kvsLayer))
    : baseLayers.artifacts

  return {
    chatHistory,
    artifacts,
    auditLog: baseLayers.auditLog,
    sessionIndex: baseLayers.sessionIndex,
    ...(syncLayer ? { sync: syncLayer } : {})
  }
}

const layersFileSystemJournaledWithSyncWebSocket = <R = never>(
  url: string,
  options?: StorageSyncLayerOptions<R>
): StorageLayersWithSync<unknown, FileSystem | Path | R> => {
  const directory = options?.directory
  const kvsLayer = KeyValueStore.layerFileSystem(
    directory ?? defaultStorageDirectory
  )
  const baseLayers = layersFileSystemJournaled(
    directory !== undefined ? { directory } : undefined
  )
  return buildJournaledSyncLayers(url, options, baseLayers, kvsLayer)
}

export const layersFileSystemBunJournaledWithSyncWebSocket = <R = never>(
  url: string,
  options?: StorageSyncLayerOptions<R>
): StorageLayersWithSync<unknown, R> => {
  const directory = options?.directory
  const kvsLayer = BunKeyValueStore.layerFileSystem(
    directory ?? defaultStorageDirectory
  )
  const baseLayers = layersFileSystemBunJournaled(
    directory !== undefined ? { directory } : undefined
  )
  return buildJournaledSyncLayers(url, options, baseLayers, kvsLayer)
}

export const layerFileSystemBunJournaledWithSyncWebSocket = <R = never>(
  url: string,
  options?: StorageSyncLayerOptions<R>
) => {
  const layers = layersFileSystemBunJournaledWithSyncWebSocket(url, options)
  const combined = mergeLayers(layers)
  return layers.sync ? Layer.merge(combined, layers.sync) : combined
}

export function layers(
  options?: StorageLayerBundleOptions & { readonly backend?: "bun" }
): StorageLayersWithSync<unknown, never>
export function layers(
  options: StorageLayerBundleOptions & { readonly backend: "filesystem" }
): StorageLayersWithSync<unknown, FileSystem | Path>
export function layers(
  options: StorageLayerBundleOptions = {}
): StorageLayersWithSync<unknown, never> | StorageLayersWithSync<unknown, FileSystem | Path> {
  const backend = options.backend ?? "bun"
  const mode = options.sync ? "journaled" : (options.mode ?? "standard")
  const directory = options.directory

  if (backend === "bun") {
    if (options.sync) {
      return layersFileSystemBunJournaledWithSyncWebSocket(
        options.sync.url,
        { ...options.sync, ...(directory !== undefined ? { directory } : {}) }
      ) as StorageLayersWithSync<unknown, never>
    }
    return mode === "journaled"
      ? (layersFileSystemBunJournaled(
          directory !== undefined ? { directory } : undefined
        ) as StorageLayersWithSync<unknown, never>)
      : (layersFileSystemBun(
          directory !== undefined ? { directory } : undefined
        ) as StorageLayersWithSync<unknown, never>)
  }

  if (options.sync) {
    return layersFileSystemJournaledWithSyncWebSocket(
      options.sync.url,
      { ...options.sync, ...(directory !== undefined ? { directory } : {}) }
    ) as StorageLayersWithSync<unknown, FileSystem | Path>
  }

  return mode === "journaled"
    ? (layersFileSystemJournaled(
        directory !== undefined ? { directory } : undefined
      ) as StorageLayersWithSync<unknown, FileSystem | Path>)
    : (layersFileSystem(
        directory !== undefined ? { directory } : undefined
      ) as StorageLayersWithSync<unknown, FileSystem | Path>)
}
