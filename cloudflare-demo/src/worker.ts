import { Sandbox } from "@cloudflare/sandbox"
import _INDEX_HTML from "./static/index.html"
const INDEX_HTML = _INDEX_HTML as unknown as string

// Re-export Sandbox Durable Object for wrangler
export { Sandbox }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Env {
  readonly ANTHROPIC_API_KEY: string
  readonly BUCKET: unknown
  readonly Sandbox: unknown
  readonly SYNC_URL?: string
}

interface ChatRequest {
  readonly prompt: string
  readonly sessionId?: string
}

// ---------------------------------------------------------------------------
// Lazy SDK import (deferred to avoid top-level crypto.randomUUID() in Workers)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _sdk: any
const getSDK = async () => {
  _sdk ??= await import("effect-claude-agent-sdk")
  return _sdk as typeof import("effect-claude-agent-sdk")
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _effect: any
const getEffect = async () => {
  _effect ??= {
    Effect: (await import("effect/Effect")).default ?? await import("effect/Effect"),
    Stream: (await import("effect/Stream")).default ?? await import("effect/Stream")
  }
  return _effect as {
    Effect: typeof import("effect/Effect")
    Stream: typeof import("effect/Stream")
  }
}

// ---------------------------------------------------------------------------
// Runtime factory (per-request — sandbox DO stubs can't cross request boundaries)
// ---------------------------------------------------------------------------

const getRuntime = async (env: Env) => {
  const { managedRuntime } = await getSDK()
  return managedRuntime({
    apiKey: env.ANTHROPIC_API_KEY,
    model: "sonnet",
    storageBackend: "r2",
    storageMode: "standard",
    storageBindings: { r2Bucket: env.BUCKET as never },
    persistence: { directory: "demo-data" },
    sandbox: {
      provider: "cloudflare",
      sandboxId: "demo-agent",
      env: { Sandbox: env.Sandbox },
      sleepAfter: "15m",
      apiKey: env.ANTHROPIC_API_KEY
    }
  }) as {
    runPromise: <A>(effect: import("effect/Effect").Effect<A, unknown, unknown>) => Promise<A>
    [Symbol.dispose]?: () => void
  }
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

const sseEvent = (event: string, data: string) => {
  // SSE spec: multi-line data requires each line to have its own "data:" prefix
  const dataLines = data.split("\n").map((line) => `data: ${line}`).join("\n")
  return `event: ${event}\n${dataLines}\n\n`
}

const sseHeaders = new Headers({
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "Access-Control-Allow-Origin": "*"
})

// ---------------------------------------------------------------------------
// Chat handler
// ---------------------------------------------------------------------------

const handleChat = async (request: Request, env: Env): Promise<Response> => {
  let body: ChatRequest
  try {
    body = await request.json() as ChatRequest
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    })
  }

  if (!body.prompt || typeof body.prompt !== "string") {
    return new Response(JSON.stringify({ error: "prompt is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    })
  }

  const [{ MessageFilters, Sandbox: SandboxNs }, { Effect, Stream }] = await Promise.all([
    getSDK(),
    getEffect()
  ])
  const rt = await getRuntime(env)
  const encoder = new TextEncoder()

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()

  const write = (event: string, data: string) =>
    writer.write(encoder.encode(sseEvent(event, data)))

  // Use SandboxService.runAgent() directly to bypass AgentSdk.query()
  // which tries to spawn a local subprocess (unsupported in Workers).
  rt.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const sandbox = yield* SandboxNs.SandboxService
        const handle = yield* sandbox.runAgent(body.prompt, {
          permissionMode: "bypassPermissions",
          ...(body.sessionId ? { resume: body.sessionId } : {})
        } as any)

        yield* handle.stream.pipe(
          Stream.runForEach((msg: any) =>
            Effect.gen(function*() {
              // Emit session_id from init message so client can resume
              if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
                yield* Effect.promise(() =>
                  write("session", JSON.stringify({ sessionId: msg.session_id }))
                )
              }

              const chunks = MessageFilters.extractTextChunks(msg)
              for (const chunk of chunks) {
                yield* Effect.promise(() => write("text", chunk))
              }

              if (MessageFilters.isResultSuccess(msg)) {
                yield* Effect.promise(() =>
                  write("result", JSON.stringify({
                    sessionId: msg.session_id,
                    cost: msg.total_cost_usd,
                    turns: msg.num_turns,
                    duration_ms: msg.duration_ms
                  }))
                )
              } else if (MessageFilters.isResultError(msg)) {
                yield* Effect.promise(() =>
                  write("error", JSON.stringify({
                    message: `Agent error: ${msg.subtype}`,
                    errors: msg.errors
                  }))
                )
              }
            })
          )
        )
      })
    )
  ).catch(async (err) => {
    await write("error", JSON.stringify({ message: String(err) }))
  }).finally(() => {
    writer.close()
  })

  return new Response(readable, { headers: sseHeaders })
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      })
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(INDEX_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      })
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env)
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" }
      })
    }

    return new Response("Not Found", { status: 404 })
  }
}
