# Gemini Image MCP (Claude Integration Guide)

This repository exposes a Model Context Protocol (MCP) tool wrapper around Google Gemini image generation/editing. Use `server.js` with MCP clients (including Anthropic Claude agents / Claude CLI) by calling tools via `tools/list` and `tools/call`.

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
  - image_path (string, required, absolute filesystem path)
  - prompt (string, required)
  - aspect_ratio (string, optional; same enum as `generate_image`)

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

And for edit:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "edit_image",
    "arguments": {
      "image_path": "/tmp/gemini-images/generated-...png",
      "prompt": "Add a glowing moon in the sky",
      "aspect_ratio": "16:9"
    }
  }
}
```

## Response structure

Successful responses from both tools include `content` as an array including:
- `image` block with `data` (base64), `mimeType`, and inline visuals
- a URI block `file://` with full saved image path
- a `text` block that confirms saved path and aspect ratio

If the generated image is too large, it is optimized via `sharp` before base64 inline return.

## `test-harness.js` usage and behavior

The harness executes the MCP server and performs JSON-RPC interactions over stdio.

- `node test-harness.js` runs all tests (tools/list + generate + edit)
- `node test-harness.js list` checks available tool metadata
- `node test-harness.js generate` runs generation tests
- `node test-harness.js edit` runs editing tests

### Examples in harness

`generate_image` call in harness:

- prompt: `A simple red circle on a white background`
- aspect_ratio: `1:1`

`edit_image` call in harness:

- pre-created 1x1 red PNG file in temp dir
- prompt: `Make this image blue instead of red`

### Validation behavior

- Input validated by `zod` in `server.js`.
- Empty prompt rejects with error.
- Non-existent `image_path` is handled and returns `isError` or throws.

## Notes

- Generated/edited images are saved under `~/.gemini-images`.
- Inline output size capped at 512 KB; beyond that `sharp` downscales/compresses.
- Server uses Gemini model `gemini-3-pro-image-preview` with `TEXT`+`IMAGE` modalities.

## Commands

- Start server: `npm start`
- Start dev watcher: `npm run dev`
- Run tests: `npm test`
- Clean & install: `npm run clean`

---

*Done.* The `Claude.md` description now contains tool definitions, parameter payloads, and test harness details for direct integration. 