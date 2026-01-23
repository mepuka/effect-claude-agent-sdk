import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { SessionManager } from "./SessionManager.js"
import type { SessionHandle, SessionError } from "./Session.js"
import type { SDKMessage, SDKUserMessage } from "./Schema/Message.js"
import type { SDKSessionOptions } from "./Schema/Session.js"

export class SessionService extends Context.Tag("@effect/claude-agent-sdk/SessionService")<
  SessionService,
  {
    readonly handle: SessionHandle
    readonly sessionId: Effect.Effect<string, SessionError>
    readonly send: (message: string | SDKUserMessage) => Effect.Effect<void, SessionError>
    readonly stream: Stream.Stream<SDKMessage, SessionError>
    readonly close: Effect.Effect<void, SessionError>
  }
>() {
  /**
   * Build a scoped session service from a SessionManager.
   */
  static readonly layer = (options: SDKSessionOptions) =>
    Layer.scoped(
      SessionService,
      Effect.gen(function*() {
        const manager = yield* SessionManager
        const handle = yield* manager.create(options)
        return SessionService.of({
          handle,
          sessionId: handle.sessionId,
          send: handle.send,
          stream: handle.stream,
          close: handle.close
        })
      })
    )

  /**
   * Convenience layer that wires SessionManager from defaults.
   */
  static readonly layerDefault = (options: SDKSessionOptions) =>
    SessionService.layer(options).pipe(
      Layer.provide(SessionManager.layerDefault)
    )

  /**
   * Convenience layer that reads SessionManager config from env.
   */
  static readonly layerDefaultFromEnv = (options: SDKSessionOptions, prefix = "AGENTSDK") =>
    SessionService.layer(options).pipe(
      Layer.provide(SessionManager.layerDefaultFromEnv(prefix))
    )
}
