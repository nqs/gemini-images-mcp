# gemini-image-mcp

An MCP server that provides image generation tools powered by OpenRouter. Runs on Cloudflare Workers.

## Tools

### `generate_image`

Generate an image from a text prompt.

| Parameter      | Type   | Required | Description                                                        |
| -------------- | ------ | -------- | ------------------------------------------------------------------ |
| `prompt`       | string | yes      | Image description (max 1500 chars)                                 |
| `aspect_ratio` | string | no       | `1:1` (default), `16:9`, `9:16`, `4:3`, or `3:4`                  |
| `style`        | string | no       | `photorealistic`, `digital art`, `line drawing`, or `diagram`      |

## Setup

### 1. Get an OpenRouter API key

Create an API key at [OpenRouter](https://openrouter.ai/).

### 2. Configure your MCP client

Add the server to your MCP configuration file (e.g. `~/.claude/mcp.json` for Claude Code, `claude_desktop_config.json` for Claude Desktop):

```json
{
  "mcpServers": {
    "gemini": {
      "type": "url",
      "url": "https://gemini.mcp.nqs.io?apiKey=YOUR_OPENROUTER_API_KEY"
    }
  }
}
```

Replace `YOUR_OPENROUTER_API_KEY` with your actual OpenRouter API key.

## Self-hosting

If you'd prefer to deploy your own instance instead of using the hosted version:

### Prerequisites

- Node.js >= 20
- A [Cloudflare](https://www.cloudflare.com/) account
- An [OpenRouter](https://openrouter.ai/) API key

### Deploy

1. Clone the repo and install dependencies:

   ```bash
   git clone https://github.com/nqs/gemini-images-mcp.git
   cd gemini-images-mcp
   npm install
   ```

2. Set your OpenRouter API key as a Wrangler secret:

   ```bash
   npx wrangler secret put OPENROUTER_API_KEY
   # Paste your OpenRouter API key when prompted
   ```

3. Update `wrangler.toml` with your own domain or remove the `routes` section to use the default `*.workers.dev` subdomain.

4. Deploy with Wrangler:

   ```bash
   npx wrangler deploy
   ```

   Or push to `main` to trigger the included GitHub Actions workflow (requires `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets).

5. Point your MCP config at your deployed URL:

   ```json
   {
     "mcpServers": {
       "gemini": {
         "type": "url",
         "url": "https://your-worker.your-subdomain.workers.dev?apiKey=YOUR_OPENROUTER_API_KEY"
       }
     }
   }
   ```

## Local development

```bash
export OPENROUTER_API_KEY="your-openrouter-key-here"
npm run dev    # starts server with file watcher
npm test       # runs the test suite
```

## Image Generation Model

This server uses `google/gemini-3.1-flash-lite-image` via OpenRouter for image generation.

## License

MIT
