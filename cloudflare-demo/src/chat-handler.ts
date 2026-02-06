export interface ChatEnv {
  readonly DEMO_AUTH_TOKEN?: string
  readonly CHAT_REQUEST_TIMEOUT_MS?: string
  readonly CHAT_MAX_PROMPT_CHARS?: string
}

interface ChatRequest {
  readonly prompt: string
  readonly sessionId?: string
}

type ChatValidationFailure = {
  readonly ok: false
  readonly code: string
  readonly message: string
}

type ChatValidationSuccess = {
  readonly ok: true
  readonly value: ChatRequest
}

type ChatValidationResult = ChatValidationFailure | ChatValidationSuccess

export type ChatDependencies<E extends ChatEnv> = {
  readonly getSDK: () => Promise<any>
  readonly getEffect: () => Promise<any>
  readonly getRuntime: (env: E) => Promise<{
    readonly runPromise: <A>(effect: any) => Promise<A>
  }>
}

const defaultChatRequestTimeoutMs = 30_000
const minChatRequestTimeoutMs = 100
const maxChatRequestTimeoutMs = 120_000
const defaultChatMaxPromptChars = 8_000
const minChatMaxPromptChars = 1
const maxChatMaxPromptChars = 100_000
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const allowedChatFields = new Set(["prompt", "sessionId"])

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

export const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })

const parsePositiveInt = (value: string | undefined) => {
  if (value === undefined) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const resolveChatRequestTimeoutMs = (env: ChatEnv) => {
  const configured = parsePositiveInt(env.CHAT_REQUEST_TIMEOUT_MS)
  return clamp(
    configured ?? defaultChatRequestTimeoutMs,
    minChatRequestTimeoutMs,
    maxChatRequestTimeoutMs
  )
}

const resolveChatMaxPromptChars = (env: ChatEnv) => {
  const configured = parsePositiveInt(env.CHAT_MAX_PROMPT_CHARS)
  return clamp(
    configured ?? defaultChatMaxPromptChars,
    minChatMaxPromptChars,
    maxChatMaxPromptChars
  )
}

export const authorizeApiRequest = (request: Request, env: ChatEnv) => {
  const expected = env.DEMO_AUTH_TOKEN?.trim()
  if (!expected) return true
  const header = request.headers.get("Authorization")
  if (!header?.startsWith("Bearer ")) return false
  const token = header.slice("Bearer ".length)
  return token === expected
}

export const unauthorizedResponse = () =>
  jsonResponse(401, {
    code: "unauthorized",
    message: "Missing or invalid bearer token."
  })

const validateChatRequest = (
  body: unknown,
  maxPromptChars: number
): ChatValidationResult => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      code: "invalid_request",
      message: "Request body must be a JSON object."
    }
  }

  const input = body as Record<string, unknown>
  const unknownFields = Object.keys(input).filter((key) => !allowedChatFields.has(key))
  if (unknownFields.length > 0) {
    return {
      ok: false,
      code: "unknown_field",
      message: `Unknown field: ${unknownFields[0]}`
    }
  }

  if (typeof input.prompt !== "string") {
    return {
      ok: false,
      code: "invalid_prompt",
      message: "prompt must be a string."
    }
  }

  const prompt = input.prompt.trim()
  if (prompt.length === 0) {
    return {
      ok: false,
      code: "invalid_prompt",
      message: "prompt must contain at least 1 non-whitespace character."
    }
  }

  if (prompt.length > maxPromptChars) {
    return {
      ok: false,
      code: "prompt_too_long",
      message: `prompt must be at most ${maxPromptChars} characters.`
    }
  }

  if (input.sessionId === undefined) {
    return {
      ok: true,
      value: { prompt }
    }
  }

  if (typeof input.sessionId !== "string") {
    return {
      ok: false,
      code: "invalid_session_id",
      message: "sessionId must be a string."
    }
  }

  const sessionId = input.sessionId.trim()
  if (!sessionIdPattern.test(sessionId)) {
    return {
      ok: false,
      code: "invalid_session_id",
      message: "sessionId format is invalid."
    }
  }

  return {
    ok: true,
    value: {
      prompt,
      sessionId
    }
  }
}

export const handleChat = async <E extends ChatEnv>(
  request: Request,
  env: E,
  dependencies: ChatDependencies<E>
): Promise<Response> => {
  let json: unknown
  try {
    json = await request.json()
  } catch {
    return jsonResponse(400, {
      code: "invalid_json",
      message: "Invalid JSON payload."
    })
  }

  const maxPromptChars = resolveChatMaxPromptChars(env)
  const body = validateChatRequest(json, maxPromptChars)
  if (!body.ok) {
    return jsonResponse(400, {
      code: body.code,
      message: body.message
    })
  }

  const [{ MessageFilters, Sandbox: SandboxNs }, { Effect, Stream }] = await Promise.all([
    dependencies.getSDK(),
    dependencies.getEffect()
  ])
  const rt = await dependencies.getRuntime(env)
  const timeoutMs = resolveChatRequestTimeoutMs(env)
  const encoder = new TextEncoder()

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  let closed = false
  let timedOut = false
  let interruptAgent: (() => Promise<void>) | undefined

  const write = (event: string, data: string) =>
    closed
      ? Promise.resolve()
      : writer
        .write(encoder.encode(sseEvent(event, data)))
        .catch(() => {
          closed = true
        })

  const closeWriter = () => {
    if (closed) return Promise.resolve()
    closed = true
    return writer.close().catch(() => {})
  }

  const timeoutId = setTimeout(() => {
    timedOut = true
    void (async () => {
      if (interruptAgent) {
        await interruptAgent()
      }
      await write("error", JSON.stringify({
        code: "request_timeout",
        message: `Request timed out after ${timeoutMs}ms.`
      }))
      await closeWriter()
    })()
  }, timeoutMs)

  // Use SandboxService.runAgent() directly to bypass AgentSdk.query()
  // which tries to spawn a local subprocess (unsupported in Workers).
  rt.runPromise(
    Effect.scoped(
      Effect.gen(function*() {
        const sandbox = yield* SandboxNs.SandboxService
        const handle = yield* sandbox.runAgent(body.value.prompt, {
          permissionMode: "bypassPermissions",
          ...(body.value.sessionId ? { resume: body.value.sessionId } : {})
        } as never)
        yield* Effect.sync(() => {
          interruptAgent = () =>
            rt.runPromise(handle.interrupt).then(
              () => undefined,
              () => undefined
            )
        })

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
                    code: "agent_error",
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
    if (timedOut) return
    await write("error", JSON.stringify({
      code: "chat_failed",
      message: err instanceof Error ? err.message : String(err)
    }))
  }).finally(() => {
    clearTimeout(timeoutId)
    void closeWriter()
  })

  return new Response(readable, { headers: sseHeaders })
}
