import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
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
      const model = yield* Config.option(Config.string("MODEL"))
      const cwd = yield* Config.option(Config.string("CWD"))
      const executable = yield* Config.option(
        Schema.Config("EXECUTABLE", Schema.Literal("bun", "deno", "node"))
      )
      const permissionMode = yield* Config.option(
        Schema.Config("PERMISSION_MODE", PermissionMode)
      )
      const settingSourcesValue = yield* Config.option(Config.string("SETTING_SOURCES"))
      const settingSources = Option.isSome(settingSourcesValue)
        ? yield* parseSettingSources(settingSourcesValue.value)
        : defaultSettingSources
      const cwdDefault = yield* Effect.sync(() => process.cwd())

      const options: Options = {
        executable: Option.getOrUndefined(executable) ?? "bun",
        cwd: Option.getOrUndefined(cwd) ?? cwdDefault,
        model: Option.getOrUndefined(model),
        permissionMode: Option.getOrUndefined(permissionMode),
        settingSources
      }

      return AgentSdkConfig.of({ options })
    })
  )
}
