import * as EventLogServer from "@effect/experimental/EventLogServer"
import * as HttpServer from "@effect/platform/HttpServer"
import * as HttpRouter from "@effect/platform/HttpRouter"
import { BunHttpServer } from "@effect/platform-bun"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export type EventLogRemoteServerOptions = {
  readonly port?: number
  readonly hostname?: string
  readonly path?: string
  readonly scheme?: "ws" | "wss"
  readonly storage?: Layer.Layer<EventLogServer.Storage>
}

export const toWebSocketUrl = (
  address: HttpServer.Address,
  options?: {
    readonly path?: string
    readonly hostname?: string
    readonly scheme?: "ws" | "wss"
  }
) => {
  if (address._tag !== "TcpAddress") {
    throw new Error("EventLogRemoteServer requires a TCP address to build a WebSocket URL.")
  }
  const hostname = options?.hostname ?? address.hostname
  const resolvedHostname = hostname === "0.0.0.0"
    ? "127.0.0.1"
    : hostname === "::"
    ? "::1"
    : hostname
  const formattedHostname =
    resolvedHostname.includes(":") && !resolvedHostname.startsWith("[")
      ? `[${resolvedHostname}]`
      : resolvedHostname
  const path = options?.path ?? "/event-log"
  const scheme = options?.scheme ?? "ws"
  return `${scheme}://${formattedHostname}:${address.port}${path}`
}

export type EventLogRemoteServerError = {
  readonly _tag: "EventLogRemoteServerError"
  readonly message: string
  readonly cause?: unknown
}

const toWebSocketUrlError = (cause: unknown): EventLogRemoteServerError => ({
  _tag: "EventLogRemoteServerError",
  message: cause instanceof Error ? cause.message : "Failed to build WebSocket URL.",
  cause
})

export const toWebSocketUrlEffect = (
  address: HttpServer.Address,
  options?: {
    readonly path?: string
    readonly hostname?: string
    readonly scheme?: "ws" | "wss"
  }
) =>
  Effect.try({
    try: () => toWebSocketUrl(address, options),
    catch: toWebSocketUrlError
  })

export class EventLogRemoteServer extends Context.Tag("@effect/claude-agent-sdk/EventLogRemoteServer")<
  EventLogRemoteServer,
  { readonly address: HttpServer.Address; readonly url: string }
>() {}

const buildBunWebSocketLayer = (
  options: EventLogRemoteServerOptions,
  port: number
) => {
  const path = (options.path ?? "/event-log") as HttpRouter.PathInput
  const storageLayer = options.storage ?? EventLogServer.layerStorageMemory

  const handler = Effect.flatten(EventLogServer.makeHandlerHttp)
  const route = HttpRouter.makeRoute("GET", path, handler)
  const router = HttpRouter.empty.pipe(HttpRouter.append(route))
  const serveLayer = Layer.unwrapEffect(
    Effect.map(HttpRouter.toHttpApp(router), (app) => HttpServer.serve(app))
  )

  const serviceLayer = Layer.effect(
    EventLogRemoteServer,
    Effect.gen(function*() {
      const server = yield* HttpServer.HttpServer
      const url = yield* toWebSocketUrlEffect(server.address, {
        path,
        ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
        ...(options.scheme !== undefined ? { scheme: options.scheme } : {})
      })
      return EventLogRemoteServer.of({
        address: server.address,
        url
      })
    })
  )

  return Layer.merge(serveLayer, serviceLayer).pipe(
    Layer.provide(storageLayer),
    Layer.provide(BunHttpServer.layer({ port, hostname: options.hostname }))
  )
}

export const layerBunWebSocket = (options: EventLogRemoteServerOptions = {}) =>
  buildBunWebSocketLayer(options, options.port ?? 8787)

export const layerBunWebSocketTest = (options: EventLogRemoteServerOptions = {}) =>
  buildBunWebSocketLayer(options, options.port ?? 0)
