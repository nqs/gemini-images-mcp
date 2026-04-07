import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
const STYLES = ["photorealistic", "digital art", "line drawing", "diagram"];
const MODEL = "gemini-3-pro-image-preview";

const TOOLS = [
  {
    name: "generate_image",
    description: "Generate an image from a text prompt using Gemini. Returns the image inline as base64.",
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
    description: "Edit an existing image using a text prompt. Pass the image as base64-encoded data.",
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
  }
];

function extractImage(result) {
  const parts = result.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find(p => p.inlineData?.data);
  return imagePart?.inlineData?.data ?? null; // already base64
}

function imageResult(base64Data, aspectRatio) {
  return {
    content: [
      { type: "image", data: base64Data, mimeType: "image/png" },
      { type: "text", text: `Image generated (${aspectRatio})` }
    ]
  };
}

async function handleGenerateImage(ai, args) {
  const parsed = z.object({
    prompt: z.string().min(1).max(1500),
    aspect_ratio: z.enum(ASPECT_RATIOS).optional().default("1:1"),
    style: z.enum(STYLES).optional()
  }).parse(args);

  const fullPrompt = parsed.style
    ? `${parsed.style}, ${parsed.prompt}, high quality, detailed`
    : `${parsed.prompt}, high quality, detailed`;

  const result = await ai.models.generateContent({
    model: MODEL,
    contents: fullPrompt,
    config: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: parsed.aspect_ratio } },
  });

  const base64Data = extractImage(result);
  if (!base64Data) {
    return { content: [{ type: "text", text: "No image returned by Gemini. Try a shorter or simpler prompt." }], isError: true };
  }
  return imageResult(base64Data, parsed.aspect_ratio);
}

async function handleEditImage(ai, args) {
  const parsed = z.object({
    image_data: z.string().min(1),
    mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]).optional().default("image/png"),
    prompt: z.string().min(1).max(1500),
    aspect_ratio: z.enum(ASPECT_RATIOS).optional()
  }).parse(args);

  const config = { responseModalities: ["TEXT", "IMAGE"] };
  if (parsed.aspect_ratio) config.imageConfig = { aspectRatio: parsed.aspect_ratio };

  const result = await ai.models.generateContent({
    model: MODEL,
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
  return imageResult(base64Data, parsed.aspect_ratio || "original");
}

function makeHandler(ai) {
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
            case "generate_image": return ok(await handleGenerateImage(ai, params.arguments));
            case "edit_image":     return ok(await handleEditImage(ai, params.arguments));
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
  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const apiKey = new URL(request.url).searchParams.get("apiKey");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Missing apiKey query parameter" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    const ai = new GoogleGenAI({ apiKey });
    const handleMcpMessage = makeHandler(ai);

    const body = await request.json();
    const messages = Array.isArray(body) ? body : [body];
    const responses = (await Promise.all(messages.map(handleMcpMessage))).filter(r => r !== null);

    if (!Array.isArray(body)) {
      if (responses.length === 0) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(responses[0]), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(responses), { headers: { "Content-Type": "application/json" } });
  }
};
