import * as Config from "effect/Config"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { ConfigError } from "./Errors.js"
import { defaultSessionLifecyclePolicy } from "./internal/lifecyclePolicy.js"
import { layerConfigFromEnv } from "./internal/config.js"
import { missingCredentialsError } from "./internal/credentials.js"
import type { SDKSessionOptions } from "./Schema/Session.js"
import { SessionPermissionMode } from "./Schema/Session.js"

export type SessionDefaults = Omit<SDKSessionOptions, "model">

export type SessionRuntimeSettings = {
  readonly closeDrainTimeout: Duration.DurationInput
  readonly turnSendTimeout?: Duration.DurationInput
  readonly turnResultTimeout?: Duration.DurationInput
}

/** Extract turn driver timeouts from runtime settings. Returns undefined when neither is set. */
export const resolveTurnTimeouts = (
  runtime: SessionRuntimeSettings
): { readonly turnSendTimeout?: Duration.DurationInput; readonly turnResultTimeout?: Duration.DurationInput } | undefined =>
  runtime.turnSendTimeout !== undefined || runtime.turnResultTimeout !== undefined
    ? {
        ...(runtime.turnSendTimeout !== undefined ? { turnSendTimeout: runtime.turnSendTimeout } : {}),
        ...(runtime.turnResultTimeout !== undefined ? { turnResultTimeout: runtime.turnResultTimeout } : {})
      }
    : undefined

export type SessionConfigSettings = {
  readonly defaults: SessionDefaults
  readonly runtime: SessionRuntimeSettings
}

const normalizeRedacted = (value: Option.Option<Redacted.Redacted>) =>
  Option.flatMap(value, (redacted) =>
    Redacted.value(redacted).trim().length > 0 ? Option.some(redacted) : Option.none()
  )

const parseList = (value: string) =>
  value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

const parseOptionalList = (value: Option.Option<string>) =>
  Option.flatMap(value, (raw) => {
    const entries = parseList(raw)
    return entries.length > 0 ? Option.some(entries) : Option.none()
  })

const decodeDurationInput = (name: string, value: string) =>
  Effect.try({
    try: () => Duration.decode(value as Duration.DurationInput),
    catch: (cause) =>
      ConfigError.make({
        message: `Invalid ${name}`,
        cause
      })
  })

const makeSessionConfig = Effect.gen(function*() {
  const apiKey = normalizeRedacted(
    yield* Config.option(Config.redacted("ANTHROPIC_API_KEY"))
  )
  const apiKeyFallback = normalizeRedacted(
    yield* Config.option(Config.redacted("API_KEY"))
  )
  const sessionAccessToken = normalizeRedacted(
    yield* Config.option(Config.redacted("CLAUDE_CODE_SESSION_ACCESS_TOKEN"))
  )

  const executable = yield* Config.option(
    Schema.Config("EXECUTABLE", Schema.Literal("bun", "node"))
  )
  const pathToClaudeCodeExecutable = yield* Config.option(
    Config.string("PATH_TO_CLAUDE_CODE_EXECUTABLE")
  )
  const executableArgsValue = yield* Config.option(Config.string("EXECUTABLE_ARGS"))
  const permissionMode = yield* Config.option(
    Schema.Config("PERMISSION_MODE", SessionPermissionMode)
  )
  const allowedToolsValue = yield* Config.option(Config.string("ALLOWED_TOOLS"))
  const disallowedToolsValue = yield* Config.option(Config.string("DISALLOWED_TOOLS"))
  const closeDrainTimeout = yield* Config.option(Config.string("CLOSE_DRAIN_TIMEOUT"))
  const turnSendTimeout = yield* Config.option(Config.string("TURN_SEND_TIMEOUT"))
  const turnResultTimeout = yield* Config.option(Config.string("TURN_RESULT_TIMEOUT"))
  const executableArgs = parseOptionalList(executableArgsValue)
  const allowedTools = parseOptionalList(allowedToolsValue)
  const disallowedTools = parseOptionalList(disallowedToolsValue)

  const processEnv = yield* Effect.sync(() => process.env)
  const resolvedApiKey = Option.isSome(apiKey) ? apiKey : apiKeyFallback
  const authEnvOverrides = {
    ...(Option.isSome(resolvedApiKey)
      ? { ANTHROPIC_API_KEY: Redacted.value(resolvedApiKey.value) }
      : {}),
    ...(Option.isSome(sessionAccessToken)
      ? {
          CLAUDE_CODE_SESSION_ACCESS_TOKEN: Redacted.value(sessionAccessToken.value)
        }
      : {})
  }
  const env =
    Object.keys(authEnvOverrides).length > 0
      ? { ...processEnv, ...authEnvOverrides }
      : undefined

  if (!Option.isSome(resolvedApiKey) && !Option.isSome(sessionAccessToken)) {
    return yield* missingCredentialsError()
  }

  const defaults: SessionDefaults = {
    executable: Option.getOrUndefined(executable) ?? "bun",
    pathToClaudeCodeExecutable: Option.getOrUndefined(pathToClaudeCodeExecutable),
    ...(Option.isSome(executableArgs) ? { executableArgs: executableArgs.value } : {}),
    permissionMode: Option.getOrUndefined(permissionMode),
    ...(Option.isSome(allowedTools) ? { allowedTools: allowedTools.value } : {}),
    ...(Option.isSome(disallowedTools) ? { disallowedTools: disallowedTools.value } : {}),
    ...(env ? { env } : {})
  }

  const runtimeBase = {
    closeDrainTimeout: Option.isSome(closeDrainTimeout)
      ? yield* decodeDurationInput("CLOSE_DRAIN_TIMEOUT", closeDrainTimeout.value)
      : defaultSessionLifecyclePolicy.closeDrainTimeout
  }

  const runtime: SessionRuntimeSettings = {
    ...runtimeBase,
    ...(Option.isSome(turnSendTimeout)
      ? {
          turnSendTimeout: yield* decodeDurationInput(
            "TURN_SEND_TIMEOUT",
            turnSendTimeout.value
          )
        }
      : {}),
    ...(Option.isSome(turnResultTimeout)
      ? {
          turnResultTimeout: yield* decodeDurationInput(
            "TURN_RESULT_TIMEOUT",
            turnResultTimeout.value
          )
        }
      : {})
  }

  return { defaults, runtime }
})

export class SessionConfig extends Effect.Service<SessionConfig>()(
  "@effect/claude-agent-sdk/SessionConfig",
  {
    effect: makeSessionConfig
  }
) {
  /**
   * Build SessionConfig by reading configuration from environment variables.
   */
  static readonly layerFromEnv = (prefix = "AGENTSDK") =>
    SessionConfig.layer.pipe(Layer.provide(layerConfigFromEnv(prefix)))

  /**
   * Default configuration layer for sessions (model must be supplied per session).
   */
  static readonly layer = SessionConfig.Default
}
