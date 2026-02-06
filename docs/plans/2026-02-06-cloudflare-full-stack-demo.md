# Cloudflare Full-Stack Demo

Deploy a complete cloud-hosted agent demo on Cloudflare: Agent Worker with R2 storage, sync worker with Durable Objects, and a minimal terminal-style chat UI.

## Components

### 1. Agent Worker (`cloudflare-demo/`)

Cloudflare Worker that serves the chat UI and exposes a streaming chat API.

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Serve chat UI (index.html) |
| POST | `/api/chat` | Accept prompt, stream SSE response |
| GET | `/api/health` | Health check |

**POST /api/chat:**
- Request: `{ "prompt": "...", "sessionId": "optional" }`
- Response: `text/event-stream`
  - `event: text` — streaming text chunks
  - `event: result` — final metadata (cost, turns)
  - `event: error` — error message

**Bindings:**
- R2 bucket `BUCKET` → `agent-demo-storage`
- Secret `ANTHROPIC_API_KEY` via `wrangler secret put`
- Var `SYNC_URL` pointing to sync worker

**Implementation:** Uses `runtimeLayer({ storageBackend: "r2", storageBindings: { r2Bucket: env.BUCKET } })` from the SDK. Each request creates a scoped Effect, streams via `MessageFilters.toTextStream`, writes SSE events.

### 2. Sync Worker (`cloudflare/`)

The existing Durable Objects sync worker, deployed as-is. Provides WebSocket event-log sync at `/event-log/<tenant>`.

### 3. Chat UI (`cloudflare-demo/src/static/index.html`)

Minimal terminal-style interface. Vanilla HTML/CSS/JS, no frameworks.

**Design:**
- Dark background, monospace font, modern CSS (custom properties, `color-mix()`, logical properties, container queries)
- Scrollable output area with `> prompt` prefix for user input, inline streamed responses
- Bottom input bar, disabled while streaming
- Status bar showing connection state and last response cost

**Behavior:**
1. User submits prompt via Enter or Send button
2. `fetch("/api/chat")` with streaming `ReadableStream` reader
3. Parse SSE events, append text chunks to output
4. Show cost on result, re-enable input on completion

## Directory Structure

```
cloudflare-demo/
  src/
    worker.ts              # Agent worker (routes + SSE streaming)
    static/
      index.html           # Chat UI
  wrangler.toml            # R2 binding, compatibility date
  package.json             # Minimal deps
```

## Deployment

```bash
# 1. Sync worker
cd cloudflare && bunx wrangler deploy

# 2. Agent worker
cd cloudflare-demo
bunx wrangler r2 bucket create agent-demo-storage
bunx wrangler secret put ANTHROPIC_API_KEY
bunx wrangler deploy

# 3. Visit https://effect-agent-demo.<subdomain>.workers.dev
```

## Out of Scope

- No auth on chat UI (demo only, API key is server-side)
- No multi-turn UI memory (R2 stores server-side, UI doesn't reload)
- No WebSocket sync in UI (sync worker deployed but not wired to frontend)
- No Cloudflare Sandbox execution (direct SDK calls only)
