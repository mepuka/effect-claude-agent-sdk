import * as Layer from "effect/Layer"
import { AgentRuntime, type RemoteSyncOptions } from "../AgentRuntime.js"
import { ConflictPolicy } from "./ConflictPolicy.js"

export type ConflictPolicyOption =
  | "lastWriteWins"
  | "firstWriteWins"
  | "reject"
  | Layer.Layer<ConflictPolicy>

export type RemoteSyncLayerOptions = Omit<RemoteSyncOptions, "url" | "conflictPolicy"> & {
  readonly conflictPolicy?: ConflictPolicyOption
}

const resolveConflictPolicyLayer = (input?: ConflictPolicyOption) => {
  if (input === undefined) return undefined
  if (typeof input !== "string") return input
  switch (input) {
    case "firstWriteWins":
      return ConflictPolicy.layerFirstWriteWins
    case "reject":
      return ConflictPolicy.layerReject()
    case "lastWriteWins":
    default:
      return ConflictPolicy.layerLastWriteWins
  }
}

/**
 * One-liner helper to wire remote sync layers for the AgentRuntime.
 */
export const withRemoteSync = (url: string, options?: RemoteSyncLayerOptions) => {
  const { conflictPolicy, ...rest } = options ?? {}
  const resolvedConflictPolicy = resolveConflictPolicyLayer(conflictPolicy)
  return AgentRuntime.layerWithRemoteSync({
    url,
    ...rest,
    ...(resolvedConflictPolicy !== undefined
      ? { conflictPolicy: resolvedConflictPolicy }
      : {})
  })
}
