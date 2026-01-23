import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { ConfigError } from "./Errors.js"
import { SessionConfig, type SessionDefaults } from "./SessionConfig.js"
import {
  createSession,
  prompt,
  resumeSession,
  SessionError,
  type SessionHandle
} from "./Session.js"
import type { SDKResultMessage } from "./Schema/Message.js"
import type { SDKSessionOptions } from "./Schema/Session.js"

export const SessionManagerError = Schema.Union(SessionError, ConfigError)

export type SessionManagerError = typeof SessionManagerError.Type
export type SessionManagerErrorEncoded = typeof SessionManagerError.Encoded

const mergeRecord = <T>(
  base: Record<string, T> | undefined,
  override: Record<string, T> | undefined
) => (base || override ? { ...(base ?? {}), ...(override ?? {}) } : undefined)

const mergeDefaults = (
  defaults: SessionDefaults,
  options: SDKSessionOptions
): SDKSessionOptions => {
  const env = mergeRecord(defaults.env, options.env)
  return {
    ...defaults,
    ...options,
    ...(env ? { env } : {})
  }
}

const requireModel = (options: SDKSessionOptions) =>
  typeof options.model === "string" && options.model.trim().length > 0
    ? Effect.succeed(options)
    : Effect.fail(
        ConfigError.make({
          message: "Session model is required"
        })
      )

export class SessionManager extends Context.Tag("@effect/claude-agent-sdk/SessionManager")<
  SessionManager,
  {
    readonly create: (options: SDKSessionOptions) => Effect.Effect<
      SessionHandle,
      SessionError | ConfigError,
      Scope.Scope
    >
    readonly resume: (sessionId: string, options: SDKSessionOptions) => Effect.Effect<
      SessionHandle,
      SessionError | ConfigError,
      Scope.Scope
    >
    readonly prompt: (
      message: string,
      options: SDKSessionOptions
    ) => Effect.Effect<SDKResultMessage, SessionError | ConfigError>
  }
>() {
  /**
   * Build SessionManager using SessionConfig defaults.
   */
  static readonly layer = Layer.effect(
    SessionManager,
    Effect.gen(function*() {
      const { defaults } = yield* SessionConfig

      const prepareOptions = Effect.fn("SessionManager.prepareOptions")(
        (options: SDKSessionOptions) =>
          requireModel(mergeDefaults(defaults, options))
      )

      const create = Effect.fn("SessionManager.create")(
        (options: SDKSessionOptions) =>
          prepareOptions(options).pipe(
            Effect.flatMap((merged) => createSession(merged))
          )
      )

      const resume = Effect.fn("SessionManager.resume")(
        (sessionId: string, options: SDKSessionOptions) =>
          prepareOptions(options).pipe(
            Effect.flatMap((merged) => resumeSession(sessionId, merged))
          )
      )

      const promptMessage = Effect.fn("SessionManager.prompt")(
        (message: string, options: SDKSessionOptions) =>
          prepareOptions(options).pipe(
            Effect.flatMap((merged) => prompt(message, merged))
          )
      )

      return SessionManager.of({
        create,
        resume,
        prompt: promptMessage
      })
    })
  )

  /**
   * Convenience layer that wires SessionConfig from defaults.
   */
  static readonly layerDefault = SessionManager.layer.pipe(
    Layer.provide(SessionConfig.layer)
  )

  /**
   * Convenience layer that reads SessionConfig from environment variables.
   */
  static readonly layerDefaultFromEnv = (prefix = "AGENTSDK") =>
    SessionManager.layer.pipe(
      Layer.provide(SessionConfig.layerFromEnv(prefix))
    )
}
