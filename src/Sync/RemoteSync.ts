import type * as Layer from "effect/Layer"
import { AgentRuntime, type RemoteSyncOptions } from "../AgentRuntime.js"
import { ConflictPolicy } from "./ConflictPolicy.js"

export type RemoteUrlOptions = {
  readonly tenant?: string
  readonly authToken?: string
}

export type ConflictPolicyOption =
  | "lastWriteWins"
  | "firstWriteWins"
  | "reject"
  | Layer.Layer<ConflictPolicy>

export type RemoteSyncLayerOptions = Omit<RemoteSyncOptions, "url" | "conflictPolicy"> & {
  readonly conflictPolicy?: ConflictPolicyOption
  readonly tenant?: string
  readonly authToken?: string
}

export const buildRemoteUrl = (baseUrl: string, options?: RemoteUrlOptions) => {
  const url = new URL(baseUrl)
  const tenant = options?.tenant
  const path = url.pathname === "/" ? "/event-log" : url.pathname
  if (tenant && (path === "/event-log" || path === "/event-log/")) {
    url.pathname = `/event-log/${tenant}`
  } else {
    url.pathname = path
  }
  if (options?.authToken) {
    url.searchParams.set("token", options.authToken)
  }
  return url.toString()
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
  const { conflictPolicy, tenant, authToken, ...rest } = options ?? {}
  const resolvedConflictPolicy = resolveConflictPolicyLayer(conflictPolicy)
  const remoteUrlOptions = {
    ...(tenant !== undefined ? { tenant } : {}),
    ...(authToken !== undefined ? { authToken } : {})
  }
  const resolvedUrl =
    Object.keys(remoteUrlOptions).length > 0
      ? buildRemoteUrl(url, remoteUrlOptions)
      : url
  return AgentRuntime.layerWithRemoteSync({
    url: resolvedUrl,
    ...rest,
    ...(resolvedConflictPolicy !== undefined
      ? { conflictPolicy: resolvedConflictPolicy }
      : {})
  })
}
