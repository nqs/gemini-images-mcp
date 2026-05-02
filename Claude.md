# Gemini Image MCP (Claude Integration Guide)

This repository exposes a Model Context Protocol (MCP) tool wrapper around Google Gemini image generation, editing, and web search. Use `server.js` with MCP clients (including Anthropic Claude agents / Claude CLI) by calling tools via `tools/list` and `tools/call`.

## Quick start

1. Set API key:

```bash
export GEMINI_API_KEY="AIza..."
```

2. Install and run:

```bash
npm install
npm start
```

3. Confirm tools:

```bash
node test-harness.js list
```

## Tool list (MCP metadata)

### generate_image
- description: Generate an image from a text prompt via Gemini
- inputSchema:
  - prompt (string, required)
  - aspect_ratio (string, optional; enum: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`; default `1:1`)
  - style (string, optional; enum: `photorealistic`, `digital art`, `line drawing`, `diagram`)

### edit_image
- description: Edit an existing image via Gemini.
- inputSchema:
  - image_data (string, required, base64-encoded image data)
  - prompt (string, required)
  - mime_type (string, optional; enum: `image/png`, `image/jpeg`, `image/webp`; default `image/png`)
  - aspect_ratio (string, optional; same enum as `generate_image`)

### google_search
- description: Search the web using Google Search via Gemini. Returns a grounded answer with source citations.
- inputSchema:
  - query (string, required, max 1000 chars)

## Parameter passing from Claude (or other MCP client)

Call the MCP request path `tools/call` with JSON-RPC method:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "generate_image",
    "arguments": {
      "prompt": "A night city skyline, neon lights, cinematic",
      "aspect_ratio": "16:9",
      "style": "digital art"
    }
  }
}
```

For edit:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "edit_image",
    "arguments": {
      "image_data": "<base64-encoded-image>",
      "prompt": "Add a glowing moon in the sky",
      "aspect_ratio": "16:9"
    }
  }
}
```

And for search:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "google_search",
    "arguments": {
      "query": "latest news about AI"
    }
  }
}
```

## Response structure

Successful image tool responses include `content` as an array including:
- `image` block with `data` (base64) and `mimeType`
- a `text` block that confirms the aspect ratio

Successful search responses include `content` as an array with:
- a `text` block containing the grounded answer and a list of source URLs

## `test-harness.js` usage and behavior

The harness executes the MCP server and performs JSON-RPC interactions over stdio.

- `node test-harness.js` runs all tests (tools/list + generate + edit + search)
- `node test-harness.js list` checks available tool metadata
- `node test-harness.js generate` runs generation tests
- `node test-harness.js edit` runs editing tests
- `node test-harness.js search` runs search tests

### Examples in harness

`generate_image` call in harness:

- prompt: `A simple red circle on a white background`
- aspect_ratio: `1:1`

`edit_image` call in harness:

- pre-created 1x1 red PNG file in temp dir
- prompt: `Make this image blue instead of red`

`google_search` call in harness:

- query: `What is the capital of France?`

### Validation behavior

- Input validated by `zod` in `server.js`.
- Empty prompt/query rejects with error.

## Remote HTTP transport (Cloudflare Worker deployment)

When deployed as a Cloudflare Worker, this server speaks the **Streamable HTTP** MCP transport (spec 2025-03-26), not the legacy HTTP+SSE transport. POST returns the JSON-RPC response inline (as `application/json` or `text/event-stream` depending on the `Accept` header); GET returns a keep-alive notification stream; notification-only POSTs return `202 Accepted`.

Stateless `SSEClientTransport` (legacy `event: endpoint` + push-via-SSE) is **not** supported because correlating the GET stream with subsequent POSTs would require Cloudflare Durable Objects.

### AnythingLLM configuration

In `anythingllm_mcp_servers.json`, the `type` field MUST be `streamable`. Using `sse` (or omitting `type`, which defaults to `sse`) will produce `Failed to start MCP server: gemini {"error":"Connection timeout"}` after 30 s.

```json
{
  "mcpServers": {
    "gemini": {
      "type": "streamable",
      "url": "https://gemini.mcp.nqs.io/?apiKey=AIza..."
    }
  }
}
```

## Notes

- Image tools use Gemini model `gemini-3-pro-image-preview` with `TEXT`+`IMAGE` modalities.
- Search tool uses Gemini model `gemini-2.5-flash` with Google Search grounding.

## Commands

- Start server: `npm start`
- Start dev watcher: `npm run dev`
- Run tests: `npm test`
- Clean & install: `npm run clean`

---

*Done.* The `Claude.md` description now contains tool definitions, parameter payloads, and test harness details for direct integration. 