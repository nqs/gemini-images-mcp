import { z } from "zod";

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const STYLES = ["photorealistic", "digital art", "line drawing", "diagram"];

const TOOLS = [
  {
    name: "generate_image",
    description: "Generate an image from a text prompt. Returns the image inline as base64.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image description. Photorealistic, art, diagrams, etc." },
        aspect_ratio: { type: "string", enum: ASPECT_RATIOS, description: "Image aspect ratio (default: 1:1)" },
        style: { type: "string", enum: STYLES, description: "Art style to apply" }
      },
      required: ["prompt"]
    }
  }
];

async function uploadToR2(env, base64Data, mimeType) {
  if (!env?.IMAGE_BUCKET) return null;
  const key = `images/${crypto.randomUUID()}.png`;
  const binary = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
  await env.IMAGE_BUCKET.put(key, binary, {
    httpMetadata: { contentType: mimeType ?? "image/png" }
  });
  const publicBase = env.R2_PUBLIC_URL?.replace(/\/$/, "");
  if (!publicBase) return null;
  return `${publicBase}/${key}`;
}

function imageResult(base64Data, aspectRatio, publicUrl) {
  if (publicUrl) {
    return {
      content: [{ type: "text", text: `Image generated (${aspectRatio}) — Public URL: ${publicUrl}` }]
    };
  }
  return {
    content: [
      { type: "image", data: base64Data, mimeType: "image/png" },
      { type: "text", text: `Image generated (${aspectRatio})` }
    ]
  };
}

function getOpenRouterSizeFromAspectRatio(ar) {
  const map = {
    "1:1": "1024x1024",
    "16:9": "1536x1024",
    "9:16": "1024x1536",
    "4:3": "1152x864",
    "3:4": "864x1152"
  };
  return map[ar] || "1024x1024";
}

async function generateImageViaPollinations(prompt, aspectRatio, style, env) {
  const fullPrompt = style
    ? `${style}, ${prompt}, high quality, detailed`
    : `${prompt}, high quality, detailed`;

  // Encode prompt for URL
  const encodedPrompt = encodeURIComponent(fullPrompt);

  // Map aspect ratio to dimensions
  const dimensions = {
    "1:1": "1024x1024",
    "16:9": "1536x1024",
    "9:16": "1024x1536",
    "4:3": "1152x864",
    "3:4": "864x1152"
  };
  const [width, height] = (dimensions[aspectRatio || "1:1"] || "1024x1024").split("x");

  // Pollinations API: https://image.pollinations.ai/prompt/{prompt}?width={w}&height={h}
  const url = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&nologo=true`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Image generation failed: ${response.statusText}`);
  }

  const imageData = await response.arrayBuffer();
  const base64Data = Buffer.from(imageData).toString("base64");
  return `data:image/png;base64,${base64Data}`;
}

async function handleGenerateImage(env, args) {
  const parsed = z.object({
    prompt: z.string().min(1).max(1500),
    aspect_ratio: z.enum(ASPECT_RATIOS).optional().default("1:1"),
    style: z.enum(STYLES).optional()
  }).parse(args);

  try {
    const base64Data = await generateImageViaPollinations(
      parsed.prompt,
      parsed.aspect_ratio,
      parsed.style,
      env
    );

    if (!base64Data) {
      return { content: [{ type: "text", text: "No image returned." }], isError: true };
    }

    // Strip data URL prefix for storage
    const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, "");

    let publicUrl = null;
    try {
      publicUrl = await uploadToR2(env, cleanBase64, "image/png");
    } catch {
      // R2 failure is non-fatal; base64 still returned
    }

    return imageResult(cleanBase64, parsed.aspect_ratio, publicUrl);
  } catch (err) {
    return { content: [{ type: "text", text: `Image generation failed: ${err.message}` }], isError: true };
  }
}

function makeHandler(env) {
  return async function handleMcpMessage(msg) {
    const { jsonrpc, id, method, params } = msg;
    const ok = result => ({ jsonrpc, id, result });
    const err = (code, message) => ({ jsonrpc, id, error: { code, message } });

    try {
      switch (method) {
        case "initialize":
          return ok({
            protocolVersion: "2024-11-05",
            serverInfo: { name: "gemini-image-mcp", version: "4.0.0" },
            capabilities: { tools: {} }
          });
        case "notifications/initialized":
          return null;
        case "ping":
          return ok({});
        case "tools/list":
          return ok({ tools: TOOLS });
        case "tools/call": {
          switch (params.name) {
            case "generate_image": return ok(await handleGenerateImage(env, params.arguments));
            default: return err(-32601, `Unknown tool: ${params.name}`);
          }
        }
        default:
          return err(-32601, `Method not found: ${method}`);
      }
    } catch (e) {
      return err(-32603, e.message);
    }
  };
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "GET") {
        const encoder = new TextEncoder();

        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`: connected\n\n`));
          },
          async pull(controller) {
            await new Promise(r => setTimeout(r, 25000));
            try {
              controller.enqueue(encoder.encode(`: ping\n\n`));
            } catch {}
          },
          cancel() {}
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
          }
        });
      }

      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const handleMcpMessage = makeHandler(env);

      const body = await request.json();
      const messages = Array.isArray(body) ? body : [body];
      const responses = (await Promise.all(messages.map(handleMcpMessage))).filter(r => r !== null);

      if (responses.length === 0) {
        return new Response(null, { status: 202 });
      }

      const acceptsSSE = request.headers.get("Accept")?.includes("text/event-stream");
      if (acceptsSSE) {
        const encoder = new TextEncoder();
        const sseBody = responses.map(r => `event: message\ndata: ${JSON.stringify(r)}\n\n`).join("");
        return new Response(encoder.encode(sseBody), {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }
        });
      }

      if (!Array.isArray(body)) {
        return new Response(JSON.stringify(responses[0]), { headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify(responses), { headers: { "Content-Type": "application/json" } });
    } catch (err) {
      return new Response(JSON.stringify({
        error: err?.message ?? String(err),
        stack: err?.stack,
        name: err?.name
      }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }
};

// Stdio transport for local testing
if (import.meta.main) {
  const env = {
    IMAGE_BUCKET: null,
    R2_PUBLIC_URL: null
  };

  const handleMcpMessage = makeHandler(env);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  process.stdin.on("data", (chunk) => {
    const json = decoder.decode(chunk);
    const messages = json.split("\n").filter(line => line.trim());

    messages.forEach(async (line) => {
      try {
        const msg = JSON.parse(line);
        const response = await handleMcpMessage(msg);
        if (response) {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      } catch (err) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg?.id,
            error: { code: -32603, message: err.message }
          }) + "\n"
        );
      }
    });
  });
}
