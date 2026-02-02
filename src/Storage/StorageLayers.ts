import { BunFileSystem, BunPath } from "@effect/platform-bun"
import * as Layer from "effect/Layer"
import { ArtifactStore } from "./ArtifactStore.js"
import { AuditEventStore } from "./AuditEventStore.js"
import { ChatHistoryStore } from "./ChatHistoryStore.js"
import { SessionIndexStore } from "./SessionIndexStore.js"

export type StorageLayerOptions = {
  readonly directory?: string
}

export type StorageLayers<E = unknown, R = unknown> = {
  readonly chatHistory: Layer.Layer<ChatHistoryStore, E, R>
  readonly artifacts: Layer.Layer<ArtifactStore, E, R>
  readonly auditLog: Layer.Layer<AuditEventStore, E, R>
  readonly sessionIndex: Layer.Layer<SessionIndexStore, E, R>
}

const resolveDirectory = (directory: string | undefined) =>
  directory === undefined ? undefined : { directory }

const resolveLayers = (
  options: StorageLayerOptions | undefined,
  kind: "filesystem" | "bun"
) => {
  const directory = resolveDirectory(options?.directory)
  return {
    chatHistory: kind === "bun"
      ? ChatHistoryStore.layerFileSystemBun(directory)
      : ChatHistoryStore.layerFileSystem(directory),
    artifacts: kind === "bun"
      ? ArtifactStore.layerFileSystemBun(directory)
      : ArtifactStore.layerFileSystem(directory),
    auditLog: kind === "bun"
      ? AuditEventStore.layerFileSystemBun(directory)
      : AuditEventStore.layerFileSystem(directory),
    sessionIndex: kind === "bun"
      ? SessionIndexStore.layerFileSystemBun(directory)
      : SessionIndexStore.layerFileSystem(directory)
  }
}

export const layersFileSystem = (options?: StorageLayerOptions) =>
  resolveLayers(options, "filesystem")

const bunFileSystemLayer = BunFileSystem.layer
const bunPathLayer = BunPath.layer

export const layersFileSystemBun = (
  options?: StorageLayerOptions
): StorageLayers<unknown, never> => {
  const layers = resolveLayers(options, "bun")
  return {
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
  }
}

export const layerFileSystem = (options?: StorageLayerOptions) => {
  const layers = resolveLayers(options, "filesystem")
  return Layer.mergeAll(
    layers.chatHistory,
    layers.artifacts,
    layers.auditLog,
    layers.sessionIndex
  )
}

export const layerFileSystemBun = (options?: StorageLayerOptions) => {
  const layers = layersFileSystemBun(options)
  return Layer.mergeAll(
    layers.chatHistory,
    layers.artifacts,
    layers.auditLog,
    layers.sessionIndex
  )
}
