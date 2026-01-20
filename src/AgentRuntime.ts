import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schedule from "effect/Schedule"
import * as Stream from "effect/Stream"
import type * as Scope from "effect/Scope"
import { AgentRuntimeConfig, type AgentRuntimeSettings } from "./AgentRuntimeConfig.js"
import type { AgentSdkError } from "./Errors.js"
import { mergeOptions } from "./internal/options.js"
import type { QueryHandle } from "./Query.js"
import { QuerySupervisor } from "./QuerySupervisor.js"
import type {
  QueryEvent,
  QuerySupervisorError,
  QuerySupervisorStats
} from "./QuerySupervisor.js"
import type { SDKMessage, SDKUserMessage } from "./Schema/Message.js"
import type { Options } from "./Schema/Options.js"

const decorateHandle = (
  handle: QueryHandle,
  settings: AgentRuntimeSettings
) =>
  Effect.gen(function*() {
    let stream = handle.stream

    if (settings.firstMessageTimeout) {
      const firstMessage = yield* Deferred.make<void>()
      stream = stream.pipe(
        Stream.tap(() => Deferred.succeed(firstMessage, undefined).pipe(Effect.ignore)),
        Stream.ensuring(Deferred.succeed(firstMessage, undefined).pipe(Effect.ignore))
      )

      yield* Effect.forkScoped(
        Deferred.await(firstMessage).pipe(
          Effect.timeoutOption(settings.firstMessageTimeout),
          Effect.flatMap((result) =>
            Option.isNone(result)
              ? handle.interrupt.pipe(Effect.ignore)
              : Effect.void
          ),
          Effect.asVoid
        )
      )
    }

    if (settings.queryTimeout) {
      yield* Effect.forkScoped(
        Effect.sleep(settings.queryTimeout).pipe(
          Effect.zipRight(handle.interrupt.pipe(Effect.ignore))
        )
      )
    }

    return {
      ...handle,
      stream
    }
  })

const applyRetry = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  settings: AgentRuntimeSettings
) =>
  settings.retryMaxRetries > 0
    ? effect.pipe(
        Effect.retry(
          Schedule.exponential(settings.retryBaseDelay).pipe(
            Schedule.compose(Schedule.recurs(settings.retryMaxRetries))
          )
        )
      )
    : effect

/**
 * AgentRuntime composes AgentSdk, QuerySupervisor, and runtime policies.
 */
export class AgentRuntime extends Context.Tag("@effect/claude-agent-sdk/AgentRuntime")<
  AgentRuntime,
  {
    readonly query: (
      prompt: string | AsyncIterable<SDKUserMessage>,
      options?: Options
    ) => Effect.Effect<QueryHandle, AgentSdkError | QuerySupervisorError, Scope.Scope>
    readonly queryRaw: (
      prompt: string | AsyncIterable<SDKUserMessage>,
      options?: Options
    ) => Effect.Effect<QueryHandle, AgentSdkError | QuerySupervisorError, Scope.Scope>
    readonly stream: (
      prompt: string | AsyncIterable<SDKUserMessage>,
      options?: Options
    ) => Stream.Stream<SDKMessage, AgentSdkError | QuerySupervisorError>
    readonly stats: Effect.Effect<QuerySupervisorStats>
    readonly interruptAll: Effect.Effect<void, AgentSdkError>
    readonly events: Stream.Stream<QueryEvent>
  }
>() {
  /**
   * Build the AgentRuntime service using AgentRuntimeConfig.
   */
  static readonly layer = Layer.effect(
    AgentRuntime,
    Effect.gen(function*() {
      const { settings } = yield* AgentRuntimeConfig
      const supervisor = yield* QuerySupervisor

      const runQuery = (prompt: string | AsyncIterable<SDKUserMessage>, options?: Options) => {
        const merged = mergeOptions(settings.defaultOptions, options)
        return applyRetry(
          supervisor.submit(prompt, merged),
          settings
        )
      }

      const query = Effect.fn("AgentRuntime.query")(function*(
        prompt: string | AsyncIterable<SDKUserMessage>,
        options?: Options
      ) {
        const handle = yield* runQuery(prompt, options)
        return yield* decorateHandle(handle, settings)
      })

      const queryRaw = Effect.fn("AgentRuntime.queryRaw")(function*(
        prompt: string | AsyncIterable<SDKUserMessage>,
        options?: Options
      ) {
        return yield* runQuery(prompt, options)
      })

      const stream = (prompt: string | AsyncIterable<SDKUserMessage>, options?: Options) =>
        Stream.unwrapScoped(
          query(prompt, options).pipe(Effect.map((handle) => handle.stream))
        )

      return AgentRuntime.of({
        query,
        queryRaw,
        stream,
        stats: supervisor.stats,
        interruptAll: supervisor.interruptAll,
        events: supervisor.events
      })
    })
  )

  /**
   * Convenience layer that wires AgentRuntimeConfig from defaults.
   */
  static readonly layerDefault = AgentRuntime.layer.pipe(
    Layer.provide(AgentRuntimeConfig.layer)
  )

  /**
   * Convenience layer that reads AgentRuntimeConfig from environment variables.
   */
  static readonly layerDefaultFromEnv = (prefix = "AGENTSDK") =>
    AgentRuntime.layer.pipe(Layer.provide(AgentRuntimeConfig.layerFromEnv(prefix)))
}
