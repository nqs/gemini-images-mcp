# Gemini Image MCP

This repository exposes a Model Context Protocol (MCP) tool wrapper around image generation. Use `server.js` with MCP clients (including Anthropic Claude agents / Claude CLI) by calling tools via `tools/list` and `tools/call`.

## Quick start

1. Install and run:

```bash
npm install
npm start
```

2. Confirm tools:

```bash
node test-harness.js list
```

## Tool list (MCP metadata)

### generate_image
- description: Generate an image from a text prompt. Returns the image inline as base64.
- inputSchema:
  - prompt (string, required)
  - aspect_ratio (string, optional; enum: `1:1`, `16:9`, `9:16`, `4:3`, `3:4`; default `1:1`)
  - style (string, optional; enum: `photorealistic`, `digital art`, `line drawing`, `diagram`)

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

## Response structure

Successful image tool responses include `content` as an array including:
- `image` block with `data` (base64) and `mimeType`
- a `text` block that confirms the aspect ratio

## `test-harness.js` usage and behavior

The harness executes the MCP server and performs JSON-RPC interactions over stdio.

- `node test-harness.js` runs all tests (tools/list + generate)
- `node test-harness.js list` checks available tool metadata
- `node test-harness.js generate` runs generation tests

### Examples in harness

`generate_image` call in harness:

- prompt: `A simple red circle on a white background`
- aspect_ratio: `1:1`

### Validation behavior

- Input validated by `zod` in `server.js`.
- Empty prompt rejects with error.

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
      "url": "https://gemini.mcp.nqs.io"
    }
  }
}
```

## Notes

- Image tool uses Pollinations.ai for free, no-key-required image generation.

## Commands

- Start server: `npm start`
- Start dev watcher: `npm run dev`
- Run tests: `npm test`
- Clean & install: `npm run clean`

---

*Done.* The `Claude.md` description now contains tool definitions and test harness details for direct integration. 
