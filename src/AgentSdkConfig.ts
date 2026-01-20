import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import { ConfigError } from "./Errors.js"
import { defaultSettingSources, layerConfigFromEnv } from "./internal/config.js"
import { Options, SettingSource } from "./Schema/Options.js"
import { PermissionMode } from "./Schema/Permission.js"

const SettingSourcesSchema = Schema.Array(SettingSource)

const parseSettingSources = (value: string) =>
  Schema.decodeUnknown(SettingSourcesSchema)(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  ).pipe(
    Effect.mapError((cause) =>
      ConfigError.make({
        message: "Invalid settingSources",
        cause
      })
    )
  )

const normalizeRedacted = (value: Option.Option<Redacted.Redacted>) =>
  Option.flatMap(value, (redacted) =>
    Redacted.value(redacted).trim().length > 0 ? Option.some(redacted) : Option.none()
  )

export class AgentSdkConfig extends Context.Tag("@effect/claude-agent-sdk/AgentSdkConfig")<
  AgentSdkConfig,
  {
    readonly options: Options
  }
>() {
  /**
   * Build AgentSdkConfig by reading configuration from environment variables.
   * Use this when wiring AgentSdk in production.
   */
  static readonly layerFromEnv = (prefix = "AGENTSDK") =>
    AgentSdkConfig.layer.pipe(Layer.provide(layerConfigFromEnv(prefix)))

  /**
   * Default configuration layer. Falls back to process defaults when unset.
   */
  static readonly layer = Layer.effect(
    AgentSdkConfig,
    Effect.gen(function*() {
      const apiKey = normalizeRedacted(
        yield* Config.option(Config.redacted("ANTHROPIC_API_KEY"))
      )
      const apiKeyFallback = normalizeRedacted(
        yield* Config.option(Config.redacted("API_KEY"))
      )
      const sessionAccessToken = normalizeRedacted(
        yield* Config.option(Config.redacted("CLAUDE_CODE_SESSION_ACCESS_TOKEN"))
      )
      const model = yield* Config.option(Config.string("MODEL"))
      const cwd = yield* Config.option(Config.string("CWD"))
      const executable = yield* Config.option(
        Schema.Config("EXECUTABLE", Schema.Literal("bun", "deno", "node"))
      )
      const allowDangerouslySkipPermissions = yield* Config.option(
        Config.boolean("ALLOW_DANGEROUSLY_SKIP_PERMISSIONS")
      )
      const permissionMode = yield* Config.option(
        Schema.Config("PERMISSION_MODE", PermissionMode)
      )
      const settingSourcesValue = yield* Config.option(Config.string("SETTING_SOURCES"))
      const settingSources = Option.isSome(settingSourcesValue)
        ? yield* parseSettingSources(settingSourcesValue.value)
        : defaultSettingSources
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
      const cwdDefault = yield* Effect.sync(() => process.cwd())

      if (!Option.isSome(resolvedApiKey) && !Option.isSome(sessionAccessToken)) {
        yield* Effect.logError(
          "Missing credentials: set ANTHROPIC_API_KEY (or API_KEY) or CLAUDE_CODE_SESSION_ACCESS_TOKEN, or sign in via Claude Code settings."
        )
      }

      const resolvedPermissionMode = Option.getOrUndefined(permissionMode)
      const allowDangerously = Option.getOrElse(allowDangerouslySkipPermissions, () => false)
      if (resolvedPermissionMode === "bypassPermissions" && !allowDangerously) {
        yield* Effect.logError(
          "PERMISSION_MODE=bypassPermissions requires ALLOW_DANGEROUSLY_SKIP_PERMISSIONS=true."
        )
      }

      const options: Options = {
        executable: Option.getOrUndefined(executable) ?? "bun",
        cwd: Option.getOrUndefined(cwd) ?? cwdDefault,
        model: Option.getOrUndefined(model),
        allowDangerouslySkipPermissions: Option.getOrUndefined(allowDangerouslySkipPermissions),
        permissionMode: Option.getOrUndefined(permissionMode),
        settingSources,
        env
      }

      return AgentSdkConfig.of({ options })
    })
  )
}
