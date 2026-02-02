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
  readonly storage?: Layer.Layer<EventLogServer.Storage>
}

export class EventLogRemoteServer extends Context.Tag("@effect/claude-agent-sdk/EventLogRemoteServer")<
  EventLogRemoteServer,
  { readonly address: HttpServer.Address }
>() {}

export const layerBunWebSocket = (options: EventLogRemoteServerOptions = {}) => {
  const port = options.port ?? 8787
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
    Effect.map(HttpServer.HttpServer, (server) =>
      EventLogRemoteServer.of({ address: server.address })
    )
  )

  return Layer.merge(serveLayer, serviceLayer).pipe(
    Layer.provide(storageLayer),
    Layer.provide(BunHttpServer.layer({ port, hostname: options.hostname }))
  )
}
