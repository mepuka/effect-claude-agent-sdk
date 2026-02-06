import { Sandbox } from "@cloudflare/sandbox"
import _INDEX_HTML from "./static/index.html"
import {
  authorizeApiRequest,
  handleChat,
  unauthorizedResponse,
  type ChatDependencies,
  type ChatEnv
} from "./chat-handler.js"

const INDEX_HTML = _INDEX_HTML as unknown as string

// Re-export Sandbox Durable Object for wrangler
export { Sandbox }

interface Env extends ChatEnv {
  readonly ANTHROPIC_API_KEY: string
  readonly BUCKET: unknown
  readonly Sandbox: unknown
  readonly SYNC_URL?: string
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

const chatDependencies: ChatDependencies<Env> = {
  getSDK,
  getEffect,
  getRuntime
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      })
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(INDEX_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      })
    }

    if (url.pathname.startsWith("/api/") && !authorizeApiRequest(request, env)) {
      return unauthorizedResponse()
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env, chatDependencies)
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" }
      })
    }

    return new Response("Not Found", { status: 404 })
  }
}
