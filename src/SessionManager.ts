import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { ConfigError } from "./Errors.js"
import { makeSessionTurnDriver } from "./internal/sessionTurnDriver.js"
import {
  SessionConfig,
  resolveTurnTimeouts,
  type SessionDefaults,
  type SessionRuntimeSettings
} from "./SessionConfig.js"
import {
  createSession,
  prompt,
  resumeSession,
  SessionError,
  type SessionHandle
} from "./Session.js"
import type { SDKResultMessage } from "./Schema/Message.js"
import type { SDKSessionOptions } from "./Schema/Session.js"
import type { SessionService } from "./SessionService.js"

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

type SessionServiceApi = Context.Tag.Service<typeof SessionService>

const makeSessionServiceWithRuntime = (
  handle: SessionHandle,
  runtime: SessionRuntimeSettings
) =>
  Effect.gen(function*() {
    const timeouts = resolveTurnTimeouts(runtime)

    const driver = yield* makeSessionTurnDriver({
      send: handle.send,
      stream: handle.stream,
      close: handle.close,
      ...(timeouts ? { timeouts } : {})
    })
    return {
      handle,
      sessionId: handle.sessionId,
      send: driver.sendRaw,
      turn: driver.turn,
      stream: driver.streamRaw,
      close: driver.shutdown.pipe(Effect.zipRight(handle.close))
    } satisfies SessionServiceApi
  })

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
    readonly withSession: <A, E, R>(
      options: SDKSessionOptions,
      use: (session: SessionServiceApi) => Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E | SessionError | ConfigError, R>
  }
>() {
  /**
   * Build SessionManager using SessionConfig defaults.
   */
  static readonly layer = Layer.effect(
    SessionManager,
    Effect.gen(function*() {
      const { defaults, runtime } = yield* SessionConfig

      const prepareOptions = Effect.fn("SessionManager.prepareOptions")(
        (options: SDKSessionOptions) =>
          requireModel(mergeDefaults(defaults, options))
      )

      const create = Effect.fn("SessionManager.create")(
        (options: SDKSessionOptions) =>
          prepareOptions(options).pipe(
            Effect.flatMap((merged) =>
              createSession(merged, {
                closeDrainTimeout: runtime.closeDrainTimeout
              })
            )
          )
      )

      const resume = Effect.fn("SessionManager.resume")(
        (sessionId: string, options: SDKSessionOptions) =>
          prepareOptions(options).pipe(
            Effect.flatMap((merged) =>
              resumeSession(sessionId, merged, {
                closeDrainTimeout: runtime.closeDrainTimeout
              })
            )
          )
      )

      const promptMessage = Effect.fn("SessionManager.prompt")(
        (message: string, options: SDKSessionOptions) =>
          prepareOptions(options).pipe(
            Effect.flatMap((merged) => prompt(message, merged))
          )
      )

      const withSession = Effect.fn("SessionManager.withSession")(
        <A, E, R>(
          options: SDKSessionOptions,
          use: (session: SessionServiceApi) => Effect.Effect<A, E, R>
        ) =>
          Effect.scoped(
            Effect.gen(function*() {
              const handle = yield* create(options)
              const session = yield* makeSessionServiceWithRuntime(handle, runtime)
              return yield* use(session)
            })
          )
      )

      return SessionManager.of({
        create,
        resume,
        prompt: promptMessage,
        withSession
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
