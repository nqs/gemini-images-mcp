import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const STYLES = ["photorealistic", "digital art", "line drawing", "diagram"];
const IMAGE_MODEL = "gemini-3-pro-image-preview";
const SEARCH_MODEL = "gemini-2.5-flash";

const TOOLS = [
  {
    name: "generate_image",
    description: "Generate an image from a text prompt using Gemini. Returns a public hosted URL when storage is configured, otherwise returns the image inline as base64.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Image description. Photorealistic, art, diagrams, etc." },
        aspect_ratio: { type: "string", enum: ASPECT_RATIOS, description: "Image aspect ratio (default: 1:1)" },
        style: { type: "string", enum: STYLES, description: "Art style to apply" }
      },
      required: ["prompt"]
    }
  },
  {
    name: "edit_image",
    description: "Edit an existing image using a text prompt. Pass the image as base64-encoded data. Returns a public hosted URL when storage is configured, otherwise returns the edited image inline as base64.",
    inputSchema: {
      type: "object",
      properties: {
        image_data: { type: "string", description: "Base64-encoded image data" },
        mime_type: {
          type: "string",
          enum: ["image/png", "image/jpeg", "image/webp"],
          description: "MIME type of the input image (default: image/png)"
        },
        prompt: { type: "string", description: "Description of the edits to make" },
        aspect_ratio: { type: "string", enum: ASPECT_RATIOS, description: "Output aspect ratio (default: preserves original)" }
      },
      required: ["image_data", "prompt"]
    }
  },
  {
    name: "google_search",
    description: "Search the web using Google Search via Gemini. Returns a grounded answer with source citations. Useful for finding current information, facts, news, and real-time data.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query to look up on Google" }
      },
      required: ["query"]
    }
  }
];

function extractImage(result) {
  const parts = result.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.data);
  return imagePart?.inlineData?.data ?? null; // already base64
}

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

async function handleGenerateImage(ai, env, args) {
  const parsed = z.object({
    prompt: z.string().min(1).max(1500),
    aspect_ratio: z.enum(ASPECT_RATIOS).optional().default("1:1"),
    style: z.enum(STYLES).optional()
  }).parse(args);

  const fullPrompt = parsed.style
    ? `${parsed.style}, ${parsed.prompt}, high quality, detailed`
    : `${parsed.prompt}, high quality, detailed`;

  const result = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: fullPrompt,
    config: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: parsed.aspect_ratio } },
  });

  const base64Data = extractImage(result);
  if (!base64Data) {
    return { content: [{ type: "text", text: "No image returned by Gemini. Try a shorter or simpler prompt." }], isError: true };
  }

  let publicUrl = null;
  try {
    publicUrl = await uploadToR2(env, base64Data, "image/png");
  } catch {
    // R2 failure is non-fatal; base64 still returned
  }

  return imageResult(base64Data, parsed.aspect_ratio, publicUrl);
}

async function handleEditImage(ai, env, args) {
  const parsed = z.object({
    image_data: z.string().min(1),
    mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]).optional().default("image/png"),
    prompt: z.string().min(1).max(1500),
    aspect_ratio: z.enum(ASPECT_RATIOS).optional()
  }).parse(args);

  const config = { responseModalities: ["TEXT", "IMAGE"] };
  if (parsed.aspect_ratio) config.imageConfig = { aspectRatio: parsed.aspect_ratio };

  const result = await ai.models.generateContent({
    model: IMAGE_MODEL,
    contents: [
      { text: parsed.prompt },
      { inlineData: { mimeType: parsed.mime_type, data: parsed.image_data } },
    ],
    config,
  });

  const base64Data = extractImage(result);
  if (!base64Data) {
    return { content: [{ type: "text", text: "No image returned by Gemini. Try a different edit prompt." }], isError: true };
  }

  let publicUrl = null;
  try {
    publicUrl = await uploadToR2(env, base64Data, "image/png");
  } catch {
    // R2 failure is non-fatal; base64 still returned
  }

  return imageResult(base64Data, parsed.aspect_ratio || "original", publicUrl);
}

async function handleGoogleSearch(ai, args) {
  const parsed = z.object({
    query: z.string().min(1).max(1000),
  }).parse(args);

  const result = await ai.models.generateContent({
    model: SEARCH_MODEL,
    contents: parsed.query,
    config: {
      tools: [{ googleSearch: {} }],
    },
  });

  const text = result.candidates?.[0]?.content?.parts
    ?.filter(p => p.text)
    .map(p => p.text)
    .join("") || "";

  const metadata = result.candidates?.[0]?.groundingMetadata;
  const chunks = metadata?.groundingChunks || [];
  const sources = chunks
    .filter(c => c.web)
    .map(c => ({ title: c.web.title, url: c.web.uri }));

  const uniqueSources = sources.filter(
    (s, i, arr) => arr.findIndex(o => o.url === s.url) === i
  );

  let responseText = text;
  if (uniqueSources.length > 0) {
    responseText += "\n\nSources:\n" + uniqueSources
      .map((s, i) => `${i + 1}. [${s.title}](${s.url})`)
      .join("\n");
  }

  return {
    content: [{ type: "text", text: responseText }]
  };
}

function makeHandler(ai, env) {
  return async function handleMcpMessage(msg) {
    const { jsonrpc, id, method, params } = msg;
    const ok = result => ({ jsonrpc, id, result });
    const err = (code, message) => ({ jsonrpc, id, error: { code, message } });

    try {
      switch (method) {
        case "initialize":
          return ok({
            protocolVersion: "2024-11-05",
            serverInfo: { name: "gemini-image-mcp", version: "3.0.0" },
            capabilities: { tools: {} }
          });
        case "notifications/initialized":
          return null;
        case "tools/list":
          return ok({ tools: TOOLS });
        case "tools/call": {
          switch (params.name) {
            case "generate_image": return ok(await handleGenerateImage(ai, env, params.arguments));
            case "edit_image":     return ok(await handleEditImage(ai, env, params.arguments));
            case "google_search":  return ok(await handleGoogleSearch(ai, params.arguments));
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
  async fetch(request, env) {
    const apiKey = new URL(request.url).searchParams.get("apiKey");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Missing apiKey query parameter" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    // MCP Streamable HTTP spec requires GET to establish an SSE listening stream
    // for server-to-client notifications. This server has none, so the stream
    // stays open idle until the client disconnects.
    if (request.method === "GET") {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      writer.write(new TextEncoder().encode(": connected\n\n"));
      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        }
      });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const ai = new GoogleGenAI({ apiKey });
    const handleMcpMessage = makeHandler(ai, env);

    const body = await request.json();
    const messages = Array.isArray(body) ? body : [body];
    const responses = (await Promise.all(messages.map(handleMcpMessage))).filter(r => r !== null);

    // MCP Streamable HTTP spec: return SSE when client accepts it, JSON otherwise.
    // AnythingLLM (type: "streamable") sends Accept: text/event-stream on POST.
    // Claude Desktop (type: "url") expects plain JSON.
    const acceptsSSE = request.headers.get("Accept")?.includes("text/event-stream");
    if (acceptsSSE) {
      const encoder = new TextEncoder();
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      for (const r of responses) {
        writer.write(encoder.encode(`event: message\ndata: ${JSON.stringify(r)}\n\n`));
      }
      writer.close();
      return new Response(readable, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }
      });
    }

    if (!Array.isArray(body)) {
      if (responses.length === 0) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(responses[0]), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(responses), { headers: { "Content-Type": "application/json" } });
  }
};
