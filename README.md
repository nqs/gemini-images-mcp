# gemini-image-mcp

An MCP server that provides image generation and editing tools powered by Google's Gemini model. Runs on Cloudflare Workers.

## Tools

### `generate_image`

Generate an image from a text prompt.

| Parameter      | Type   | Required | Description                                                        |
| -------------- | ------ | -------- | ------------------------------------------------------------------ |
| `prompt`       | string | yes      | Image description (max 1500 chars)                                 |
| `aspect_ratio` | string | no       | `1:1` (default), `16:9`, `9:16`, `4:3`, or `3:4`                  |
| `style`        | string | no       | `photorealistic`, `digital art`, `line drawing`, or `diagram`      |

### `edit_image`

Edit an existing image using a text prompt.

| Parameter      | Type   | Required | Description                                                        |
| -------------- | ------ | -------- | ------------------------------------------------------------------ |
| `image_data`   | string | yes      | Base64-encoded image data                                          |
| `prompt`       | string | yes      | Description of the edits to make (max 1500 chars)                  |
| `mime_type`    | string | no       | `image/png` (default), `image/jpeg`, or `image/webp`              |
| `aspect_ratio` | string | no       | Output aspect ratio (preserves original if omitted)                |

## Setup

### 1. Get a Gemini API key

Create an API key at [Google AI Studio](https://aistudio.google.com/apikey).

### 2. Configure your MCP client

Add the server to your MCP configuration file (e.g. `~/.claude/mcp.json` for Claude Code, `claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "gemini-images": {
      "type": "url",
      "url": "https://gemini.mcp.nqs.io?apiKey=YOUR_GEMINI_API_KEY"
    }
  }
}
```

Replace `YOUR_GEMINI_API_KEY` with your actual key.

## Self-hosting

If you'd prefer to deploy your own instance instead of using the hosted version:

### Prerequisites

- Node.js >= 20
- A [Cloudflare](https://www.cloudflare.com/) account

### Deploy

1. Clone the repo and install dependencies:

   ```bash
   git clone https://github.com/nqs/gemini-images-mcp.git
   cd gemini-images-mcp
   npm install
   ```

2. Update `wrangler.toml` with your own domain or remove the `routes` section to use the default `*.workers.dev` subdomain.

3. Deploy with Wrangler:

   ```bash
   npx wrangler deploy
   ```

   Or push to `main` to trigger the included GitHub Actions workflow (requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets).

4. Point your MCP config at your deployed URL:

   ```json
   {
     "mcpServers": {
       "gemini-images": {
         "type": "url",
         "url": "https://your-worker.your-subdomain.workers.dev?apiKey=YOUR_GEMINI_API_KEY"
       }
     }
   }
   ```

## Local development

```bash
export GEMINI_API_KEY="YOUR_KEY"
npm run dev    # starts server with file watcher
npm test       # runs the test suite
```

## License

MIT
